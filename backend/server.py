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
    puesto: Optional[str] = None


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    email: EmailStr
    name: str
    role: str
    area: Optional[str] = None
    puesto: Optional[str] = None


class UserUpdateIn(BaseModel):
    name: Optional[str] = None
    puesto: Optional[str] = None


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


UnitLiteral = Literal["m3", "m", "cm", "mm", "km", "none"]


class ReportIn(BaseModel):
    title: str
    comments: str = ""
    area: str
    images: List[str] = Field(default_factory=list)  # base64 data URLs
    location: Optional[str] = None
    priority: Literal[1, 2, 3] = 1  # 1=Informativo, 2=Importante, 3=Urgente
    # --- Intelligent report fields ---
    reference_point_id: Optional[str] = None
    reference_point_name: Optional[str] = None
    coordinates: Optional[str] = None
    first_reading: Optional[float] = None
    last_reading: Optional[float] = None
    unit: Optional[UnitLiteral] = None
    activities: Optional[str] = None
    personnel: List[str] = Field(default_factory=list)
    equipment: List[str] = Field(default_factory=list)
    files: List[dict] = Field(default_factory=list)  # [{name, mimeType, dataUrl}]


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
    createdByPuesto: Optional[str] = None
    createdAt: str
    status: str = "synced"
    priority: int = 1
    # --- Intelligent report fields ---
    reference_point_id: Optional[str] = None
    reference_point_name: Optional[str] = None
    coordinates: Optional[str] = None
    first_reading: Optional[float] = None
    last_reading: Optional[float] = None
    unit: Optional[str] = None
    progress: Optional[float] = None  # auto-calculated Última - Primera
    activities: Optional[str] = None
    personnel: List[str] = Field(default_factory=list)
    equipment: List[str] = Field(default_factory=list)
    files: List[dict] = Field(default_factory=list)
    contract: Optional[str] = None
    contractor: Optional[str] = None


# --- Reference Points (Postes) -----------------------
class ReferencePointIn(BaseModel):
    name: str
    location: Optional[str] = None
    coordinates: Optional[str] = None
    area: Optional[str] = None  # None = available to all areas


class ReferencePointOut(BaseModel):
    id: str
    name: str
    location: Optional[str] = None
    coordinates: Optional[str] = None
    area: Optional[str] = None
    areaName: Optional[str] = None
    createdBy: str
    createdByName: str
    createdAt: str


# --- Site Config (project-wide singleton) ------------
class SiteConfigIn(BaseModel):
    contract: Optional[str] = None
    contractor: Optional[str] = None


class SiteConfigOut(BaseModel):
    contract: str = ""
    contractor: str = ""
    updatedAt: Optional[str] = None
    updatedBy: Optional[str] = None


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


class ActivityIn(BaseModel):
    title: str
    description: str = ""
    priority: Literal[1, 2, 3] = 1  # 1=Informativo, 2=Importante, 3=Urgente
    area: Optional[str] = None  # None = global (only coordinadores)


class ActivityOut(BaseModel):
    id: str
    title: str
    description: str
    priority: int
    area: Optional[str] = None
    areaName: Optional[str] = None
    createdBy: str
    createdByName: str
    createdByRole: str
    createdAt: str


class PeriodSummaryIn(BaseModel):
    period: Literal["daily", "weekly", "monthly"]
    area: Optional[str] = None  # None = all areas (coordinador only)


# --- Chat (direct messaging) -----------------------------
class ChatSendIn(BaseModel):
    to_user: str
    text: str


class ChatMessageOut(BaseModel):
    id: str
    from_user: str
    from_name: str
    to_user: str
    to_name: str
    text: str
    createdAt: str
    read: bool = False


class ChatUserOut(BaseModel):
    id: str
    name: str
    email: str
    role: str
    area: Optional[str] = None
    areaName: Optional[str] = None
    puesto: Optional[str] = None
    lastMessage: Optional[str] = None
    lastAt: Optional[str] = None
    unread: int = 0


# --- Calendar / Eventos ---------------------------------
class FileAttachment(BaseModel):
    name: str
    mimeType: str
    dataUrl: str  # base64 data URL (e.g. "data:application/pdf;base64,...")


class EventIn(BaseModel):
    title: str
    description: str = ""
    date: str  # ISO datetime (event start)
    location: Optional[str] = None
    area: Optional[str] = None  # None = global
    alert_at: Optional[str] = None  # ISO datetime when alert fires
    notify_all: bool = True  # alert to all users


class EventOut(BaseModel):
    id: str
    title: str
    description: str
    date: str
    location: Optional[str] = None
    area: Optional[str] = None
    areaName: Optional[str] = None
    alert_at: Optional[str] = None
    notify_all: bool = True
    createdBy: str
    createdByName: str
    createdAt: str


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
        puesto=doc.get("puesto"),
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
        "puesto": (body.puesto or "").strip() or None,
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


@api.put("/auth/me", response_model=UserOut)
async def update_me(body: UserUpdateIn, user: dict = Depends(get_current_user)):
    """Allows the user to update their own profile (name / puesto)."""
    updates: dict = {}
    if body.name is not None:
        n = body.name.strip()
        if not n:
            raise HTTPException(status_code=400, detail="Nombre inválido")
        updates["name"] = n
    if body.puesto is not None:
        updates["puesto"] = body.puesto.strip() or None
    if not updates:
        raise HTTPException(status_code=400, detail="Nada para actualizar")
    await db.users.update_one({"id": user["id"]}, {"$set": updates})
    fresh = await db.users.find_one({"id": user["id"]}, {"_id": 0, "password": 0})
    return user_doc_to_out(fresh)


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


# --- Routes: Reference Points (Postes) -------------------------------------
@api.get("/reference-points", response_model=List[ReferencePointOut])
async def list_reference_points(user: dict = Depends(get_current_user)):
    """Lista los puntos de referencia visibles para el usuario:
    - Coordinador: ve todos.
    - Especialista: ve los globales (area=None) + los de su área.
    """
    query: dict = {}
    if user["role"] == "especialista":
        query["$or"] = [{"area": user.get("area")}, {"area": None}]
    cursor = db.reference_points.find(query, {"_id": 0}).sort("name", 1)
    out: List[ReferencePointOut] = []
    async for p in cursor:
        if p.get("area"):
            p["areaName"] = await get_area_name(p["area"])
        else:
            p["areaName"] = "Global"
        out.append(ReferencePointOut(**p))
    return out


@api.post("/reference-points", response_model=ReferencePointOut)
async def create_reference_point(body: ReferencePointIn, user: dict = Depends(get_current_user)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nombre requerido")
    # Determine target area:
    # - Especialista: forced to their own area (cannot create global)
    # - Coordinador: can pass area=None (global) or any existing area
    target_area: Optional[str] = body.area
    if user["role"] == "especialista":
        if not user.get("area"):
            raise HTTPException(status_code=400, detail="Sin área asignada")
        target_area = user["area"]
    else:
        if target_area and not await area_exists(target_area):
            raise HTTPException(status_code=400, detail="Área inválida")

    # Prevent duplicates inside same scope (area or global)
    dup_query: dict = {"name": name, "area": target_area}
    if await db.reference_points.find_one(dup_query):
        raise HTTPException(status_code=400, detail="Ya existe un punto con ese nombre")

    pid = str(uuid.uuid4())
    doc = {
        "id": pid,
        "name": name,
        "location": (body.location or "").strip() or None,
        "coordinates": (body.coordinates or "").strip() or None,
        "area": target_area,
        "createdBy": user["id"],
        "createdByName": user["name"],
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    await db.reference_points.insert_one(doc)
    doc.pop("_id", None)
    doc["areaName"] = await get_area_name(target_area) if target_area else "Global"
    return ReferencePointOut(**doc)


@api.put("/reference-points/{point_id}", response_model=ReferencePointOut)
async def update_reference_point(
    point_id: str,
    body: ReferencePointIn,
    user: dict = Depends(get_current_user),
):
    """Edita un punto de referencia existente.
    - Coordinador puede editar cualquiera y mover entre global/área.
    - Especialista solo puede editar los suyos y dentro de su propia área.
    """
    p = await db.reference_points.find_one({"id": point_id}, {"_id": 0})
    if not p:
        raise HTTPException(status_code=404, detail="Punto no encontrado")
    if user["role"] != "coordinador" and p["createdBy"] != user["id"]:
        raise HTTPException(status_code=403, detail="Sin permiso")

    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nombre requerido")

    target_area: Optional[str] = body.area
    if user["role"] == "especialista":
        # Especialistas no pueden cambiar el área (ni hacer global).
        target_area = user.get("area")
    else:
        if target_area and not await area_exists(target_area):
            raise HTTPException(status_code=400, detail="Área inválida")

    # Evitar duplicados (mismo nombre + mismo scope) excluyendo este punto.
    dup = await db.reference_points.find_one({
        "name": name,
        "area": target_area,
        "id": {"$ne": point_id},
    })
    if dup:
        raise HTTPException(status_code=400, detail="Ya existe un punto con ese nombre")

    updates = {
        "name": name,
        "location": (body.location or "").strip() or None,
        "coordinates": (body.coordinates or "").strip() or None,
        "area": target_area,
    }
    await db.reference_points.update_one({"id": point_id}, {"$set": updates})

    p.update(updates)
    p["areaName"] = await get_area_name(target_area) if target_area else "Global"
    return ReferencePointOut(**p)


@api.delete("/reference-points/{point_id}")
async def delete_reference_point(point_id: str, user: dict = Depends(get_current_user)):
    p = await db.reference_points.find_one({"id": point_id}, {"_id": 0})
    if not p:
        raise HTTPException(status_code=404, detail="Punto no encontrado")
    # Coordinador can delete any; especialistas can delete only their own.
    if user["role"] != "coordinador" and p["createdBy"] != user["id"]:
        raise HTTPException(status_code=403, detail="Sin permiso")
    await db.reference_points.delete_one({"id": point_id})
    return {"ok": True}


# --- Routes: Site Config (Contract / Contractor) ---------------------------
@api.get("/site-config", response_model=SiteConfigOut)
async def get_site_config(_: dict = Depends(get_current_user)):
    cfg = await db.site_config.find_one({"id": "default"}, {"_id": 0}) or {}
    return SiteConfigOut(
        contract=cfg.get("contract") or "",
        contractor=cfg.get("contractor") or "",
        updatedAt=cfg.get("updatedAt"),
        updatedBy=cfg.get("updatedByName"),
    )


@api.put("/site-config", response_model=SiteConfigOut)
async def update_site_config(body: SiteConfigIn, user: dict = Depends(get_current_user)):
    if user["role"] != "coordinador":
        raise HTTPException(status_code=403, detail="Solo coordinadores pueden actualizar la configuración")
    updates = {
        "id": "default",
        "contract": (body.contract or "").strip(),
        "contractor": (body.contractor or "").strip(),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "updatedBy": user["id"],
        "updatedByName": user["name"],
    }
    await db.site_config.update_one(
        {"id": "default"}, {"$set": updates}, upsert=True
    )
    return SiteConfigOut(
        contract=updates["contract"],
        contractor=updates["contractor"],
        updatedAt=updates["updatedAt"],
        updatedBy=updates["updatedByName"],
    )


# --- Routes: Report History (autocomplete data) ----------------------------
@api.get("/report-history")
async def report_history(user: dict = Depends(get_current_user)):
    """Devuelve datos históricos para autocompletado en el formulario.
    Compartido por área: extrae personal y equipos únicos de los reportes
    previos del área del usuario (o el área pedida por un coordinador).
    """
    target_area: Optional[str] = None
    if user["role"] == "especialista":
        target_area = user.get("area")
    # Coordinator without area filter receives an empty set (no área context)
    query: dict = {}
    if target_area:
        query["area"] = target_area

    personnel_set: set = set()
    equipment_set: set = set()
    activities_set: list = []
    seen_activities: set = set()

    async for r in db.reports.find(
        query, {"_id": 0, "personnel": 1, "equipment": 1, "activities": 1, "createdAt": 1}
    ).sort("createdAt", -1).limit(200):
        for p in (r.get("personnel") or []):
            if p and p.strip():
                personnel_set.add(p.strip())
        for e in (r.get("equipment") or []):
            if e and e.strip():
                equipment_set.add(e.strip())
        act = (r.get("activities") or "").strip()
        if act and act not in seen_activities:
            seen_activities.add(act)
            activities_set.append(act)

    return {
        "personnel": sorted(personnel_set, key=str.lower),
        "equipment": sorted(equipment_set, key=str.lower),
        "activities": activities_set[:25],
        "area": target_area,
    }


# --- Routes: Reports --------------------------------------------------------
@api.post("/reports", response_model=ReportOut)
async def create_report(body: ReportIn, user: dict = Depends(get_current_user)):
    if not await area_exists(body.area):
        raise HTTPException(status_code=400, detail="Área inválida")
    if user["role"] == "especialista" and user.get("area") != body.area:
        raise HTTPException(status_code=403, detail="No puedes reportar en otra área")

    # Snapshot site config (contract / contractor) into the report
    cfg = await db.site_config.find_one({"id": "default"}, {"_id": 0}) or {}

    # Calculate progress (avance)
    progress: Optional[float] = None
    if (
        body.first_reading is not None
        and body.last_reading is not None
        and body.unit
        and body.unit != "none"
    ):
        try:
            progress = round(float(body.last_reading) - float(body.first_reading), 4)
        except Exception:
            progress = None

    # Clean personnel / equipment / files lists
    personnel = [p.strip() for p in (body.personnel or []) if p and p.strip()]
    equipment = [e.strip() for e in (body.equipment or []) if e and e.strip()]
    files = []
    for f in (body.files or []):
        if not isinstance(f, dict):
            continue
        if f.get("dataUrl") and f.get("name"):
            files.append({
                "name": str(f.get("name"))[:200],
                "mimeType": str(f.get("mimeType") or "application/octet-stream"),
                "dataUrl": str(f.get("dataUrl")),
            })

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
        "createdByPuesto": user.get("puesto"),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "status": "synced",
        "priority": int(getattr(body, "priority", 1) or 1),
        "reference_point_id": body.reference_point_id,
        "reference_point_name": body.reference_point_name,
        "coordinates": body.coordinates,
        "first_reading": body.first_reading,
        "last_reading": body.last_reading,
        "unit": body.unit,
        "progress": progress,
        "activities": body.activities,
        "personnel": personnel,
        "equipment": equipment,
        "files": files,
        "contract": cfg.get("contract") or None,
        "contractor": cfg.get("contractor") or None,
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
        r.setdefault("createdByPuesto", None)
        r.setdefault("priority", 1)
        r.setdefault("personnel", [])
        r.setdefault("equipment", [])
        r.setdefault("files", [])
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
        r.setdefault("createdByPuesto", None)
        r.setdefault("priority", 1)
        r.setdefault("personnel", [])
        r.setdefault("equipment", [])
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
async def _gemini_chat(system: str, prompt: str, temperature: float = 0.7) -> str:
    chat = (
        LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"syncsite-{uuid.uuid4()}",
            system_message=system,
        )
        .with_model("gemini", "gemini-2.5-flash")
        .with_params(temperature=temperature)
    )
    reply = await chat.send_message(UserMessage(text=prompt))
    return reply if isinstance(reply, str) else str(reply)


@api.post("/ai/improve-text", response_model=AITextOut)
async def ai_improve(body: AITextIn, user: dict = Depends(get_current_user)):
    if not body.title and not body.comments:
        raise HTTPException(status_code=400, detail="Sin contenido")
    area_name = await get_area_name(body.area)
    # Prompt estricto anti-alucinaciones: SOLO limpia ortografía/gramática/claridad.
    system = (
        "Actúa como un Ingeniero Civil Supervisor de Obra estricto y profesional. "
        "Tu única tarea es tomar las notas de campo del usuario y mejorar la ortografía, "
        "gramática y claridad para que luzcan como un reporte técnico formal. "
        "ESTÁ ESTRICTAMENTE PROHIBIDO inventar datos, agregar eventos que no se mencionan "
        "en el texto original, o redactar historias. Solo limpia, estructura y "
        "profesionaliza el texto ingresado."
    )
    prompt = (
        f"Área del reporte (solo contexto, NO la incluyas en la salida): {area_name}\n\n"
        f"TÍTULO ORIGINAL:\n{body.title or '(sin título)'}\n\n"
        f"NOTAS ORIGINALES DEL USUARIO:\n{body.comments or '(sin notas)'}\n\n"
        "Devuelve SOLO el texto profesionalizado (corregido en ortografía, gramática y "
        "claridad) preservando ÚNICAMENTE la información presente en el original. "
        "No agregues encabezados, viñetas, ni las palabras 'Título:' o 'Reporte:'. "
        "Si el texto original es muy breve, devuélvelo igual de breve pero correcto. "
        "Nunca inventes datos, fechas, cantidades, personal, equipo, ubicaciones ni eventos."
    )
    try:
        # Temperatura muy baja: respuestas deterministas, sin creatividad.
        text = await _gemini_chat(system, prompt, temperature=0.1)
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


# --- Routes: Activities (Noticias / FYP) ------------------------------------
def _period_window(period: Optional[str], tz_offset_minutes: int = 0):
    """Returns (start_iso, end_iso) for filtering activities.

    The window is computed relative to NOW shifted by tz_offset_minutes (minutes east of UTC),
    so a client in UTC-6 sends -360 and gets a window aligned to their local day.
    """
    if not period or period == "all":
        return None, None
    now_utc = datetime.now(timezone.utc)
    # convert to "client local" by subtracting offset
    local = now_utc + timedelta(minutes=tz_offset_minutes)
    if period == "daily":
        start_local = local.replace(hour=0, minute=0, second=0, microsecond=0)
        end_local = start_local + timedelta(days=1)
    elif period == "weekly":
        days_back = local.weekday()  # Monday=0
        start_local = (local - timedelta(days=days_back)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        end_local = start_local + timedelta(days=7)
    elif period == "monthly":
        start_local = local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        # add ~32 days then snap to next month's 1st
        nxt = (start_local + timedelta(days=32)).replace(day=1)
        end_local = nxt
    else:
        return None, None
    # back to UTC ISO
    start_utc = (start_local - timedelta(minutes=tz_offset_minutes)).replace(tzinfo=timezone.utc)
    end_utc = (end_local - timedelta(minutes=tz_offset_minutes)).replace(tzinfo=timezone.utc)
    return start_utc.isoformat(), end_utc.isoformat()


@api.get("/activities", response_model=List[ActivityOut])
async def list_activities(
    user: dict = Depends(get_current_user),
    period: Optional[str] = None,  # "daily" | "weekly" | "monthly" | "all"
    tz_offset: int = 0,  # minutes east of UTC (browser: -getTimezoneOffset())
):
    """Returns activities filtered by role and (optional) time window:
    - Especialista: only own area + global (area=None) activities.
    - Coordinador: sees everything across areas.
    """
    query: dict = {}
    if user["role"] == "especialista":
        query["$or"] = [{"area": user.get("area")}, {"area": None}]
    start_iso, end_iso = _period_window(period, tz_offset)
    if start_iso and end_iso:
        query["createdAt"] = {"$gte": start_iso, "$lt": end_iso}
    cursor = db.activities.find(query, {"_id": 0}).sort("createdAt", -1).limit(200)
    out: List[ActivityOut] = []
    async for a in cursor:
        if a.get("area"):
            a["areaName"] = await get_area_name(a["area"])
        else:
            a["areaName"] = "Global"
        out.append(ActivityOut(**a))
    # Sort by priority desc, then date desc
    out.sort(key=lambda x: (-x.priority, x.createdAt), reverse=False)
    out.sort(key=lambda x: x.priority, reverse=True)
    return out


@api.post("/activities", response_model=ActivityOut)
async def create_activity(body: ActivityIn, user: dict = Depends(get_current_user)):
    if not body.title.strip():
        raise HTTPException(status_code=400, detail="Título requerido")
    # Resolve area
    target_area = body.area
    if user["role"] == "especialista":
        # Especialista can only post to their own area, never global
        if not user.get("area"):
            raise HTTPException(status_code=400, detail="Sin área asignada")
        target_area = user["area"]
    else:
        # Coordinador can post global (None) or to a specific existing area
        if target_area and not await area_exists(target_area):
            raise HTTPException(status_code=400, detail="Área inválida")

    aid = str(uuid.uuid4())
    doc = {
        "id": aid,
        "title": body.title.strip(),
        "description": body.description.strip(),
        "priority": int(body.priority),
        "area": target_area,
        "createdBy": user["id"],
        "createdByName": user["name"],
        "createdByRole": user["role"],
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    await db.activities.insert_one(doc)
    doc.pop("_id", None)
    doc["areaName"] = await get_area_name(target_area) if target_area else "Global"
    return ActivityOut(**doc)


@api.delete("/activities/{activity_id}")
async def delete_activity(activity_id: str, user: dict = Depends(get_current_user)):
    a = await db.activities.find_one({"id": activity_id}, {"_id": 0})
    if not a:
        raise HTTPException(status_code=404, detail="Noticia no encontrada")
    if a["createdBy"] != user["id"] and user["role"] != "coordinador":
        raise HTTPException(status_code=403, detail="Sin permiso")
    await db.activities.delete_one({"id": activity_id})
    return {"ok": True}


# --- Routes: Period-based AI Summary (Daily/Weekly/Monthly) -----------------
@api.post("/ai/period-summary", response_model=SummaryOut)
async def ai_period_summary(body: PeriodSummaryIn, user: dict = Depends(get_current_user)):
    """Generates AI summary of REPORTS for a given period (daily/weekly/monthly)
    and optional area filter. Triggered manually by a button to save tokens.
    """
    now = datetime.now(timezone.utc)
    if body.period == "daily":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        label = "del día de hoy"
    elif body.period == "weekly":
        start = (now - timedelta(days=7)).replace(hour=0, minute=0, second=0, microsecond=0)
        label = "de los últimos 7 días"
    else:
        start = (now - timedelta(days=30)).replace(hour=0, minute=0, second=0, microsecond=0)
        label = "de los últimos 30 días"

    # Build query
    query: dict = {"createdAt": {"$gte": start.isoformat()}}
    # Especialista: force area
    if user["role"] == "especialista":
        if not user.get("area"):
            raise HTTPException(status_code=400, detail="Sin área asignada")
        query["area"] = user["area"]
    elif body.area:
        query["area"] = body.area

    reports = []
    async for r in db.reports.find(query, {"_id": 0}).sort("createdAt", -1).limit(300):
        r.setdefault("areaName", await get_area_name(r.get("area", "")))
        reports.append(r)

    if not reports:
        return SummaryOut(
            summary=f"No hay reportes registrados {label}. "
            "Crea reportes para que el resumen ejecutivo pueda generarse."
        )

    system = (
        "Eres el Director del Proyecto. Generas resúmenes ejecutivos claros y accionables "
        "a partir de reportes de campo, en español."
    )
    compact = [
        {
            "area": r.get("areaName") or r.get("area"),
            "titulo": r.get("title"),
            "comentarios": r.get("comments"),
            "autor": r.get("createdByName"),
            "fecha": r.get("createdAt", "")[:10],
        }
        for r in reports
    ]
    period_text = {"daily": "del día", "weekly": "semanal", "monthly": "mensual"}[body.period]
    prompt = (
        f"Analiza los siguientes reportes de obra y genera un resumen ejecutivo {period_text}. "
        f"Agrupa por área, resalta problemas urgentes o de seguridad, identifica tendencias y "
        f"da una conclusión sobre el progreso. Sé claro y accionable.\n\n"
        f"Reportes ({len(reports)}): {compact}\n\n"
        f"Formato: párrafos claros, máximo 280 palabras. Sin viñetas ni emojis."
    )
    try:
        text = await _gemini_chat(system, prompt)
        return SummaryOut(summary=text.strip())
    except Exception as e:
        log.exception("AI period summary failed")
        raise HTTPException(status_code=502, detail=f"IA no disponible: {e}")


# --- Routes: Chat (Direct Messaging) ----------------------------------------
def _chat_key(a: str, b: str) -> List[str]:
    return sorted([a, b])


@api.get("/chat/users", response_model=List[ChatUserOut])
async def chat_users(user: dict = Depends(get_current_user)):
    """Lista de usuarios para iniciar conversación, con último mensaje y no leídos."""
    uid = user["id"]
    users_cursor = db.users.find(
        {"id": {"$ne": uid}}, {"_id": 0, "password": 0}
    )
    out: List[ChatUserOut] = []
    async for u in users_cursor:
        # Last message (in either direction)
        last = await db.chat_messages.find_one(
            {"$or": [
                {"from_user": uid, "to_user": u["id"]},
                {"from_user": u["id"], "to_user": uid},
            ]},
            {"_id": 0},
            sort=[("createdAt", -1)],
        )
        unread = await db.chat_messages.count_documents(
            {"from_user": u["id"], "to_user": uid, "read": False}
        )
        area_name: Optional[str] = None
        if u.get("area"):
            area_name = await get_area_name(u["area"])
        out.append(ChatUserOut(
            id=u["id"], name=u["name"], email=u["email"], role=u["role"],
            area=u.get("area"), areaName=area_name, puesto=u.get("puesto"),
            lastMessage=(last or {}).get("text"),
            lastAt=(last or {}).get("createdAt"),
            unread=unread,
        ))
    # Sort by lastAt desc, fallback name asc
    out.sort(key=lambda x: (x.lastAt or "0", x.name), reverse=True)
    return out


@api.get("/chat/messages/{peer_id}", response_model=List[ChatMessageOut])
async def chat_messages(peer_id: str, user: dict = Depends(get_current_user)):
    uid = user["id"]
    peer = await db.users.find_one({"id": peer_id}, {"_id": 0, "password": 0})
    if not peer:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    cursor = db.chat_messages.find(
        {"$or": [
            {"from_user": uid, "to_user": peer_id},
            {"from_user": peer_id, "to_user": uid},
        ]},
        {"_id": 0},
    ).sort("createdAt", 1).limit(500)
    msgs = [ChatMessageOut(**m) async for m in cursor]
    # Mark incoming as read
    await db.chat_messages.update_many(
        {"from_user": peer_id, "to_user": uid, "read": False},
        {"$set": {"read": True}},
    )
    return msgs


@api.post("/chat/send", response_model=ChatMessageOut)
async def chat_send(body: ChatSendIn, user: dict = Depends(get_current_user)):
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Mensaje vacío")
    if len(text) > 2000:
        raise HTTPException(status_code=400, detail="Mensaje demasiado largo")
    if body.to_user == user["id"]:
        raise HTTPException(status_code=400, detail="No puedes enviarte mensajes a ti mismo")
    peer = await db.users.find_one({"id": body.to_user}, {"_id": 0, "password": 0})
    if not peer:
        raise HTTPException(status_code=404, detail="Destinatario no encontrado")
    mid = str(uuid.uuid4())
    doc = {
        "id": mid,
        "from_user": user["id"],
        "from_name": user["name"],
        "to_user": peer["id"],
        "to_name": peer["name"],
        "text": text,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "read": False,
    }
    await db.chat_messages.insert_one(doc)
    doc.pop("_id", None)
    return ChatMessageOut(**doc)


@api.get("/chat/unread-total")
async def chat_unread_total(user: dict = Depends(get_current_user)):
    n = await db.chat_messages.count_documents(
        {"to_user": user["id"], "read": False}
    )
    return {"unread": n}


# --- Chat por Área (broadcast) -------------------------------------
class AreaChatSendIn(BaseModel):
    area_id: str  # "general" or one of the area ids
    text: str


class AreaChatMessageOut(BaseModel):
    id: str
    area_id: str
    area_name: str
    from_user: str
    from_name: str
    from_role: str
    text: str
    createdAt: str


class AreaRoomOut(BaseModel):
    id: str  # "general" or area id
    name: str
    color: Optional[str] = None
    icon: Optional[str] = None
    lastMessage: Optional[str] = None
    lastAt: Optional[str] = None
    lastFrom: Optional[str] = None


async def _area_name(area_id: str) -> str:
    if area_id == "general":
        return "General (todos)"
    return (await get_area_name(area_id)) or area_id


@api.get("/chat/areas", response_model=List[AreaRoomOut])
async def chat_area_rooms(user: dict = Depends(get_current_user)):
    # Build rooms: General + every area in DB
    rooms: List[AreaRoomOut] = []
    general_last = await db.chat_area_messages.find_one(
        {"area_id": "general"}, {"_id": 0}, sort=[("createdAt", -1)]
    )
    rooms.append(AreaRoomOut(
        id="general", name="General (todos)", color="#2563EB", icon="globe",
        lastMessage=(general_last or {}).get("text"),
        lastAt=(general_last or {}).get("createdAt"),
        lastFrom=(general_last or {}).get("from_name"),
    ))
    async for a in db.areas.find({}, {"_id": 0}):
        last = await db.chat_area_messages.find_one(
            {"area_id": a["id"]}, {"_id": 0}, sort=[("createdAt", -1)]
        )
        rooms.append(AreaRoomOut(
            id=a["id"], name=a["name"], color=a.get("color"), icon=a.get("icon"),
            lastMessage=(last or {}).get("text"),
            lastAt=(last or {}).get("createdAt"),
            lastFrom=(last or {}).get("from_name"),
        ))
    return rooms


@api.get("/chat/area/{area_id}/messages", response_model=List[AreaChatMessageOut])
async def chat_area_messages(area_id: str, user: dict = Depends(get_current_user)):
    cursor = db.chat_area_messages.find(
        {"area_id": area_id}, {"_id": 0}
    ).sort("createdAt", 1).limit(500)
    return [AreaChatMessageOut(**m) async for m in cursor]


@api.post("/chat/area/send", response_model=AreaChatMessageOut)
async def chat_area_send(body: AreaChatSendIn, user: dict = Depends(get_current_user)):
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Mensaje vacío")
    if len(text) > 2000:
        raise HTTPException(status_code=400, detail="Mensaje demasiado largo")
    area_id = body.area_id.strip()
    if area_id != "general":
        # Validate area exists
        exists = await db.areas.find_one({"id": area_id}, {"_id": 0})
        if not exists:
            raise HTTPException(status_code=404, detail="Área no encontrada")
    area_name = await _area_name(area_id)
    mid = str(uuid.uuid4())
    doc = {
        "id": mid,
        "area_id": area_id,
        "area_name": area_name,
        "from_user": user["id"],
        "from_name": user["name"],
        "from_role": user["role"],
        "text": text,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    await db.chat_area_messages.insert_one(doc)
    doc.pop("_id", None)
    return AreaChatMessageOut(**doc)


# --- Routes: Calendar / Eventos ---------------------------------------
@api.get("/events", response_model=List[EventOut])
async def list_events(
    user: dict = Depends(get_current_user),
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
):
    """Lista de eventos visibles para el usuario.
    Especialista ve: globales (area=None) + de su área.
    Supervisor ve: todos.
    """
    query: dict = {}
    if user["role"] == "especialista":
        query["$or"] = [{"area": user.get("area")}, {"area": None}]
    if from_date or to_date:
        date_q: dict = {}
        if from_date:
            date_q["$gte"] = from_date
        if to_date:
            date_q["$lte"] = to_date
        query["date"] = date_q
    cursor = db.events.find(query, {"_id": 0}).sort("date", 1).limit(500)
    out: List[EventOut] = []
    async for e in cursor:
        if e.get("area"):
            e["areaName"] = await get_area_name(e["area"])
        else:
            e["areaName"] = "Global"
        out.append(EventOut(**e))
    return out


@api.post("/events", response_model=EventOut)
async def create_event(body: EventIn, user: dict = Depends(get_current_user)):
    if not body.title.strip():
        raise HTTPException(status_code=400, detail="Título requerido")
    if not body.date:
        raise HTTPException(status_code=400, detail="Fecha requerida")
    area_id = body.area
    if area_id and not await area_exists(area_id):
        raise HTTPException(status_code=400, detail="Área inválida")
    eid = str(uuid.uuid4())
    area_name = await get_area_name(area_id) if area_id else "Global"
    doc = {
        "id": eid,
        "title": body.title.strip()[:200],
        "description": (body.description or "").strip()[:2000],
        "date": body.date,
        "location": (body.location or None) and body.location.strip()[:200],
        "area": area_id,
        "areaName": area_name,
        "alert_at": body.alert_at,
        "notify_all": bool(body.notify_all),
        "createdBy": user["id"],
        "createdByName": user["name"],
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    await db.events.insert_one(doc)
    doc.pop("_id", None)
    return EventOut(**doc)


@api.put("/events/{event_id}", response_model=EventOut)
async def update_event(event_id: str, body: EventIn, user: dict = Depends(get_current_user)):
    existing = await db.events.find_one({"id": event_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Evento no encontrado")
    # Author or supervisor only
    if user["role"] != "coordinador" and existing.get("createdBy") != user["id"]:
        raise HTTPException(status_code=403, detail="No puedes editar este evento")
    area_id = body.area
    if area_id and not await area_exists(area_id):
        raise HTTPException(status_code=400, detail="Área inválida")
    area_name = await get_area_name(area_id) if area_id else "Global"
    update = {
        "title": body.title.strip()[:200],
        "description": (body.description or "").strip()[:2000],
        "date": body.date,
        "location": (body.location or None) and body.location.strip()[:200],
        "area": area_id,
        "areaName": area_name,
        "alert_at": body.alert_at,
        "notify_all": bool(body.notify_all),
    }
    await db.events.update_one({"id": event_id}, {"$set": update})
    merged = {**existing, **update}
    merged.pop("_id", None)
    return EventOut(**merged)


@api.delete("/events/{event_id}")
async def delete_event(event_id: str, user: dict = Depends(get_current_user)):
    existing = await db.events.find_one({"id": event_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Evento no encontrado")
    if user["role"] != "coordinador" and existing.get("createdBy") != user["id"]:
        raise HTTPException(status_code=403, detail="No puedes eliminar este evento")
    await db.events.delete_one({"id": event_id})
    return {"ok": True}


@api.get("/events/alerts")
async def event_alerts(user: dict = Depends(get_current_user)):
    """Devuelve eventos cuya alert_at ya pasó (próximos 24h) y aún no han sido descartados
    por este usuario. Usado por el frontend para mostrar notificaciones in-app."""
    now = datetime.now(timezone.utc)
    horizon = now + timedelta(hours=24)
    query: dict = {
        "alert_at": {"$lte": horizon.isoformat()},
        "notify_all": True,
    }
    if user["role"] == "especialista":
        query["$or"] = [{"area": user.get("area")}, {"area": None}]
    cursor = db.events.find(query, {"_id": 0}).sort("alert_at", 1)
    fired: list = []
    async for e in cursor:
        if not e.get("alert_at"):
            continue
        # Skip if user already dismissed this alert
        dismissed = await db.event_alert_dismissals.find_one(
            {"event_id": e["id"], "user_id": user["id"]}, {"_id": 0}
        )
        if dismissed:
            continue
        e.pop("_id", None)
        fired.append(e)
    return fired


@api.post("/events/{event_id}/dismiss-alert")
async def dismiss_alert(event_id: str, user: dict = Depends(get_current_user)):
    await db.event_alert_dismissals.update_one(
        {"event_id": event_id, "user_id": user["id"]},
        {"$set": {"event_id": event_id, "user_id": user["id"],
                  "at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    return {"ok": True}


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
     "role": "coordinador", "area": None, "puesto": "Director de Proyecto", "password": "demo1234"},
    {"email": "geotecnia@syncsite.com", "name": "Ana Geotécnica",
     "role": "especialista", "area": "geotecnia", "puesto": "Ingeniera Geotécnica", "password": "demo1234"},
    {"email": "topografia@syncsite.com", "name": "Luis Topógrafo",
     "role": "especialista", "area": "topografia", "puesto": "Topógrafo Senior", "password": "demo1234"},
    {"email": "obracivil@syncsite.com", "name": "María Obra Civil",
     "role": "especialista", "area": "obracivil", "puesto": "Residente de Obra", "password": "demo1234"},
    {"email": "seguridad@syncsite.com", "name": "Pedro Seguridad",
     "role": "especialista", "area": "seguridad", "puesto": "Supervisor HSE", "password": "demo1234"},
    {"email": "calidad@syncsite.com", "name": "Sofía Calidad",
     "role": "especialista", "area": "calidad", "puesto": "Inspectora de Calidad", "password": "demo1234"},
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
        existing = await db.users.find_one({"email": u["email"]})
        if not existing:
            await db.users.insert_one({
                "id": str(uuid.uuid4()),
                "email": u["email"],
                "name": u["name"],
                "password": hash_password(u["password"]),
                "role": u["role"],
                "area": u["area"],
                "puesto": u.get("puesto"),
                "createdAt": datetime.now(timezone.utc).isoformat(),
            })
        elif not existing.get("puesto") and u.get("puesto"):
            # Backfill puesto for existing seed users
            await db.users.update_one(
                {"email": u["email"]},
                {"$set": {"puesto": u["puesto"]}},
            )
    log.info("Seed ready: %d areas, %d users", len(SEED_AREAS), len(SEED_USERS))


@app.on_event("shutdown")
async def shutdown():
    client.close()
