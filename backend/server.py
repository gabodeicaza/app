"""SyncSite API - Construction site reporting backend.

Provides JWT auth, role-based reports (coordinador / especialista),
dynamic area management, and AI text helpers powered by Gemini 2.5 Flash.
"""
import os
import re
import uuid
import logging
import unicodedata
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Literal

import jwt
import bcrypt
from dotenv import load_dotenv
from fastapi import FastAPI, APIRouter, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field, EmailStr

from emergentintegrations.llm.chat import LlmChat, UserMessage

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# --- Config -----------------------------------------------------------------
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALGORITHM = os.environ["JWT_ALGORITHM"]
JWT_EXPIRE_MINUTES = int(os.environ["JWT_EXPIRE_MINUTES"])
EMERGENT_LLM_KEY = os.environ["EMERGENT_LLM_KEY"]

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

app = FastAPI(title="SyncSite API")
api = APIRouter(prefix="/api")
bearer = HTTPBearer(auto_error=False)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("syncsite")


# --- Models -----------------------------------------------------------------
class RegisterIn(BaseModel):
    email: EmailStr
    password: str
    name: str
    role: Literal["coordinador", "especialista"]
    area: Optional[str] = None


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    email: EmailStr
    name: str
    role: str
    area: Optional[str] = None


class AuthResponse(BaseModel):
    token: str
    user: UserOut


class AreaIn(BaseModel):
    name: str
    color: Optional[str] = "#1E40AF"
    icon: Optional[str] = "hardhat"


class AreaOut(BaseModel):
    id: str
    name: str
    color: str
    icon: str


class ReportIn(BaseModel):
    title: str
    comments: str = ""
    area: str
    images: List[str] = Field(default_factory=list)  # base64 data URLs
    location: Optional[str] = None


class ReportOut(BaseModel):
    id: str
    title: str
    comments: str
    area: str
    areaName: str
    images: List[str]
    location: Optional[str] = None
    createdBy: str
    createdByName: str
    createdByRole: str
    createdAt: str
    status: str = "synced"


class AITextIn(BaseModel):
    title: str = ""
    comments: str = ""
    area: str


class AITextOut(BaseModel):
    text: str


class SummaryIn(BaseModel):
    reports: List[dict]


class SummaryOut(BaseModel):
    summary: str


# --- Helpers ----------------------------------------------------------------
def slugify(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "area"


def hash_password(pwd: str) -> str:
    return bcrypt.hashpw(pwd.encode(), bcrypt.gensalt()).decode()


def verify_password(pwd: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pwd.encode(), hashed.encode())
    except Exception:
        return False


def make_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRE_MINUTES),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


async def get_current_user(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer),
) -> dict:
    if not creds:
        raise HTTPException(status_code=401, detail="Token requerido")
    try:
        data = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        uid = data["sub"]
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Token inválido")
    user = await db.users.find_one({"id": uid}, {"_id": 0, "password": 0})
    if not user:
        raise HTTPException(status_code=401, detail="Usuario no encontrado")
    return user


def user_doc_to_out(doc: dict) -> UserOut:
    return UserOut(
        id=doc["id"], email=doc["email"], name=doc["name"],
        role=doc["role"], area=doc.get("area"),
    )


async def area_exists(area_id: str) -> Optional[dict]:
    return await db.areas.find_one({"id": area_id}, {"_id": 0})


async def get_area_name(area_id: str) -> str:
    a = await area_exists(area_id)
    return a["name"] if a else area_id


# --- Routes: Auth -----------------------------------------------------------
@api.post("/auth/register", response_model=AuthResponse)
async def register(body: RegisterIn):
    if body.role == "especialista":
        if not body.area or not await area_exists(body.area):
            raise HTTPException(status_code=400, detail="Área inválida para especialista")
    existing = await db.users.find_one({"email": body.email.lower()})
    if existing:
        raise HTTPException(status_code=400, detail="Email ya registrado")
    uid = str(uuid.uuid4())
    doc = {
        "id": uid,
        "email": body.email.lower(),
        "name": body.name,
        "password": hash_password(body.password),
        "role": body.role,
        "area": body.area if body.role == "especialista" else None,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    await db.users.insert_one(doc)
    return AuthResponse(token=make_token(uid), user=user_doc_to_out(doc))


@api.post("/auth/login", response_model=AuthResponse)
async def login(body: LoginIn):
    user = await db.users.find_one({"email": body.email.lower()})
    if not user or not verify_password(body.password, user["password"]):
        raise HTTPException(status_code=401, detail="Credenciales inválidas")
    return AuthResponse(token=make_token(user["id"]), user=user_doc_to_out(user))


@api.get("/auth/me", response_model=UserOut)
async def me(user: dict = Depends(get_current_user)):
    return user_doc_to_out(user)


# --- Routes: Areas ----------------------------------------------------------
@api.get("/areas", response_model=List[AreaOut])
async def list_areas(_: dict = Depends(get_current_user)):
    cursor = db.areas.find({}, {"_id": 0}).sort("name", 1)
    return [AreaOut(**a) async for a in cursor]


@api.post("/areas", response_model=AreaOut)
async def create_area(body: AreaIn, user: dict = Depends(get_current_user)):
    if user["role"] != "coordinador":
        raise HTTPException(status_code=403, detail="Solo coordinadores pueden agregar áreas")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nombre requerido")
    aid = slugify(name)
    if await area_exists(aid):
        raise HTTPException(status_code=400, detail="El área ya existe")
    doc = {
        "id": aid,
        "name": name,
        "color": body.color or "#1E40AF",
        "icon": body.icon or "hardhat",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "createdBy": user["id"],
    }
    await db.areas.insert_one(doc)
    doc.pop("_id", None)
    return AreaOut(**doc)


@api.delete("/areas/{area_id}")
async def delete_area(area_id: str, user: dict = Depends(get_current_user)):
    if user["role"] != "coordinador":
        raise HTTPException(status_code=403, detail="Solo coordinadores")
    # Prevent deletion if a specialist or report uses it
    in_use_user = await db.users.find_one({"area": area_id})
    if in_use_user:
        raise HTTPException(status_code=400, detail="Área en uso por algún especialista")
    res = await db.areas.delete_one({"id": area_id})
    if not res.deleted_count:
        raise HTTPException(status_code=404, detail="Área no encontrada")
    return {"ok": True}


# --- Routes: Reports --------------------------------------------------------
@api.post("/reports", response_model=ReportOut)
async def create_report(body: ReportIn, user: dict = Depends(get_current_user)):
    if not await area_exists(body.area):
        raise HTTPException(status_code=400, detail="Área inválida")
    if user["role"] == "especialista" and user.get("area") != body.area:
        raise HTTPException(status_code=403, detail="No puedes reportar en otra área")

    rid = f"REP-{body.area.upper()[:3]}-{str(uuid.uuid4())[:8]}"
    area_name = await get_area_name(body.area)
    doc = {
        "id": rid,
        "title": body.title,
        "comments": body.comments,
        "area": body.area,
        "areaName": area_name,
        "images": body.images,
        "location": body.location,
        "createdBy": user["id"],
        "createdByName": user["name"],
        "createdByRole": user["role"],
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "status": "synced",
    }
    await db.reports.insert_one(doc)
    doc.pop("_id", None)
    return ReportOut(**doc)


@api.get("/reports", response_model=List[ReportOut])
async def list_reports(user: dict = Depends(get_current_user)):
    query: dict = {}
    if user["role"] == "especialista":
        # Especialistas see all reports of their own area (own + colleagues).
        if user.get("area"):
            query["area"] = user["area"]
        else:
            query["createdBy"] = user["id"]
    cursor = db.reports.find(query, {"_id": 0}).sort("createdAt", -1).limit(200)
    out: List[ReportOut] = []
    async for r in cursor:
        r.setdefault("areaName", await get_area_name(r.get("area", "")))
        r.setdefault("location", None)
        out.append(ReportOut(**r))
    return out


@api.get("/reports/today")
async def reports_today(user: dict = Depends(get_current_user)):
    """Today's reports + per-area stats."""
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    cursor = db.reports.find(
        {"createdAt": {"$gte": today.isoformat()}}, {"_id": 0}
    ).sort("createdAt", -1)
    reports = []
    async for r in cursor:
        r.setdefault("areaName", await get_area_name(r.get("area", "")))
        r.setdefault("location", None)
        reports.append(r)

    # Per-area stats based on existing areas
    areas = [a async for a in db.areas.find({}, {"_id": 0})]
    stats = {a["id"]: {"name": a["name"], "color": a["color"], "count": 0} for a in areas}
    for r in reports:
        a = r["area"]
        if a in stats:
            stats[a]["count"] += 1
        else:
            stats[a] = {"name": r.get("areaName", a), "color": "#64748B", "count": 1}
    return {"reports": reports, "stats": stats, "total": len(reports)}


# --- Routes: AI -------------------------------------------------------------
async def _gemini_chat(system: str, prompt: str) -> str:
    chat = LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=f"syncsite-{uuid.uuid4()}",
        system_message=system,
    ).with_model("gemini", "gemini-2.5-flash")
    reply = await chat.send_message(UserMessage(text=prompt))
    return reply if isinstance(reply, str) else str(reply)


@api.post("/ai/improve-text", response_model=AITextOut)
async def ai_improve(body: AITextIn, user: dict = Depends(get_current_user)):
    if not body.title and not body.comments:
        raise HTTPException(status_code=400, detail="Sin contenido")
    area_name = await get_area_name(body.area)
    system = (
        "Eres un ingeniero redactor técnico de obra civil. "
        "Transformas notas informales en reportes profesionales en español."
    )
    prompt = (
        f"Toma este breve reporte de campo del área de {area_name} y reescríbelo con un "
        f"tono técnico, profesional y detallado, ideal para un reporte oficial de obra.\n\n"
        f"Título original: {body.title}\n"
        f"Notas originales: {body.comments}\n\n"
        f"Devuelve SOLO el texto del reporte mejorado, sin encabezados, sin viñetas, "
        f"sin la palabra 'Título:' ni 'Reporte:'. Mantén entre 60 y 180 palabras."
    )
    try:
        text = await _gemini_chat(system, prompt)
        return AITextOut(text=text.strip())
    except Exception as e:
        log.exception("AI improve failed")
        raise HTTPException(status_code=502, detail=f"IA no disponible: {e}")


@api.post("/ai/daily-summary", response_model=SummaryOut)
async def ai_summary(body: SummaryIn, user: dict = Depends(get_current_user)):
    if not body.reports:
        raise HTTPException(status_code=400, detail="Sin reportes para analizar")
    if user["role"] != "coordinador":
        raise HTTPException(status_code=403, detail="Solo coordinadores")
    system = (
        "Eres el Director del Proyecto. Generas resúmenes ejecutivos claros y accionables "
        "a partir de múltiples reportes de campo, en español."
    )
    compact = [
        {
            "area": r.get("areaName") or r.get("area"),
            "titulo": r.get("title"),
            "comentarios": r.get("comments"),
            "autor": r.get("createdByName"),
        }
        for r in body.reports
    ]
    prompt = (
        f"Analiza los siguientes reportes de obra del día y genera un resumen ejecutivo. "
        f"Agrupa por área, resalta cualquier problema urgente o de seguridad, y da una "
        f"conclusión sobre el progreso del día.\n\nReportes: {compact}\n\n"
        f"Formato: párrafos claros, máximo 250 palabras. Sin viñetas."
    )
    try:
        text = await _gemini_chat(system, prompt)
        return SummaryOut(summary=text.strip())
    except Exception as e:
        log.exception("AI summary failed")
        raise HTTPException(status_code=502, detail=f"IA no disponible: {e}")


# --- Health -----------------------------------------------------------------
@api.get("/")
async def health():
    return {"status": "ok", "service": "syncsite"}


app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Seed -------------------------------------------------------------------
SEED_AREAS = [
    {"id": "geotecnia",  "name": "Geotecnia",  "color": "#D97706", "icon": "mountain"},
    {"id": "topografia", "name": "Topografía", "color": "#059669", "icon": "map"},
    {"id": "obracivil",  "name": "Obra Civil", "color": "#2563EB", "icon": "hammer"},
    {"id": "seguridad",  "name": "Seguridad",  "color": "#DC2626", "icon": "shield"},
    {"id": "calidad",    "name": "Calidad",    "color": "#7C3AED", "icon": "check-circle"},
]

SEED_USERS = [
    {"email": "coordinador@syncsite.com", "name": "Carlos Coordinador",
     "role": "coordinador", "area": None, "password": "demo1234"},
    {"email": "geotecnia@syncsite.com", "name": "Ana Geotécnica",
     "role": "especialista", "area": "geotecnia", "password": "demo1234"},
    {"email": "topografia@syncsite.com", "name": "Luis Topógrafo",
     "role": "especialista", "area": "topografia", "password": "demo1234"},
    {"email": "obracivil@syncsite.com", "name": "María Obra Civil",
     "role": "especialista", "area": "obracivil", "password": "demo1234"},
    {"email": "seguridad@syncsite.com", "name": "Pedro Seguridad",
     "role": "especialista", "area": "seguridad", "password": "demo1234"},
    {"email": "calidad@syncsite.com", "name": "Sofía Calidad",
     "role": "especialista", "area": "calidad", "password": "demo1234"},
]


@app.on_event("startup")
async def seed():
    for a in SEED_AREAS:
        if not await db.areas.find_one({"id": a["id"]}):
            await db.areas.insert_one({
                **a,
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "createdBy": "system",
            })
    for u in SEED_USERS:
        if not await db.users.find_one({"email": u["email"]}):
            await db.users.insert_one({
                "id": str(uuid.uuid4()),
                "email": u["email"],
                "name": u["name"],
                "password": hash_password(u["password"]),
                "role": u["role"],
                "area": u["area"],
                "createdAt": datetime.now(timezone.utc).isoformat(),
            })
    log.info("Seed ready: %d areas, %d users", len(SEED_AREAS), len(SEED_USERS))


@app.on_event("shutdown")
async def shutdown():
    client.close()
