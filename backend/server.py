"""SyncSite API - Construction site reporting backend.

Provides JWT auth, role-based reports (coordinador / especialista),
and AI text helpers powered by Gemini 2.5 Flash via emergentintegrations.
"""
import os
import uuid
import logging
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Literal

import jwt
import bcrypt
from dotenv import load_dotenv
from fastapi import FastAPI, APIRouter, HTTPException, Depends, status
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

VALID_AREAS = {"geotecnia", "topografia", "obracivil", "seguridad", "calidad"}

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


class ReportIn(BaseModel):
    title: str
    comments: str = ""
    area: str
    images: List[str] = Field(default_factory=list)  # base64 data URLs


class ReportOut(BaseModel):
    id: str
    title: str
    comments: str
    area: str
    images: List[str]
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
        raise HTTPException(status_code=401, detail="Missing token")
    try:
        data = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        uid = data["sub"]
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = await db.users.find_one({"id": uid}, {"_id": 0, "password": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def user_doc_to_out(doc: dict) -> UserOut:
    return UserOut(
        id=doc["id"],
        email=doc["email"],
        name=doc["name"],
        role=doc["role"],
        area=doc.get("area"),
    )


# --- Routes: Auth -----------------------------------------------------------
@api.post("/auth/register", response_model=AuthResponse)
async def register(body: RegisterIn):
    if body.role == "especialista" and (not body.area or body.area not in VALID_AREAS):
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


# --- Routes: Reports --------------------------------------------------------
@api.post("/reports", response_model=ReportOut)
async def create_report(body: ReportIn, user: dict = Depends(get_current_user)):
    if body.area not in VALID_AREAS:
        raise HTTPException(status_code=400, detail="Área inválida")
    if user["role"] == "especialista" and user.get("area") != body.area:
        raise HTTPException(status_code=403, detail="No puedes reportar en otra área")

    rid = f"REP-{body.area.upper()[:3]}-{str(uuid.uuid4())[:8]}"
    doc = {
        "id": rid,
        "title": body.title,
        "comments": body.comments,
        "area": body.area,
        "images": body.images,
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
        query["createdBy"] = user["id"]
    cursor = db.reports.find(query, {"_id": 0}).sort("createdAt", -1).limit(200)
    return [ReportOut(**r) async for r in cursor]


@api.get("/reports/today")
async def reports_today(user: dict = Depends(get_current_user)):
    """Today's reports + per-area stats (coordinador view)."""
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    cursor = db.reports.find(
        {"createdAt": {"$gte": today.isoformat()}}, {"_id": 0}
    ).sort("createdAt", -1)
    reports = [r async for r in cursor]

    stats = {a: {"count": 0, "synced": 0, "pending": 0} for a in VALID_AREAS}
    for r in reports:
        a = r["area"]
        if a in stats:
            stats[a]["count"] += 1
            if r.get("status") == "synced":
                stats[a]["synced"] += 1
            else:
                stats[a]["pending"] += 1
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
    system = (
        "Eres un ingeniero redactor técnico de obra civil. "
        "Transformas notas informales en reportes profesionales en español."
    )
    prompt = (
        f"Toma este breve reporte de campo del área de {body.area} y reescríbelo con un "
        f"tono técnico, profesional y detallado, ideal para un reporte oficial de obra.\n\n"
        f"Título original: {body.title}\n"
        f"Notas originales: {body.comments}\n\n"
        f"Solo devuelve el texto mejorado, sin introducciones ni encabezados."
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
        {"area": r.get("area"), "titulo": r.get("title"), "comentarios": r.get("comments")}
        for r in body.reports
    ]
    prompt = (
        f"Analiza los siguientes reportes de obra del día y genera un resumen ejecutivo. "
        f"Agrupa por área, resalta cualquier problema urgente o de seguridad, y da una "
        f"conclusión sobre el progreso del día.\n\nReportes: {compact}\n\n"
        f"Formato: texto claro y conciso, máximo 250 palabras."
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


# --- Seed demo users --------------------------------------------------------
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
async def seed_users():
    for u in SEED_USERS:
        existing = await db.users.find_one({"email": u["email"]})
        if not existing:
            await db.users.insert_one({
                "id": str(uuid.uuid4()),
                "email": u["email"],
                "name": u["name"],
                "password": hash_password(u["password"]),
                "role": u["role"],
                "area": u["area"],
                "createdAt": datetime.now(timezone.utc).isoformat(),
            })
    log.info("Seed users ready")


@app.on_event("shutdown")
async def shutdown():
    client.close()
