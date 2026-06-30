"""SynCo v2.0 — SaaS Multiproyecto para reportes de obra.

Arquitectura:
- Coordinador General (god mode): único que crea proyectos, árbol de nodos,
  áreas e invitaciones.
- Sub-Coordinador: scope_node_id (un nodo del árbol; ve todo lo que cuelga).
- Especialista: area + puesto + scope_node_ids (hojas autorizadas a capturar).
- Sin auto-registro. Acceso 100% por token de invitación.
"""
import os
import re
import io
import uuid
import logging
import secrets
import asyncio
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Literal
try:
    from zoneinfo import ZoneInfo  # Python 3.9+
    MX_TZ = ZoneInfo("America/Mexico_City")
except Exception:  # pragma: no cover
    MX_TZ = timezone(timedelta(hours=-6))  # fallback CST

import jwt
import bcrypt
from dotenv import load_dotenv
from fastapi import FastAPI, APIRouter, HTTPException, Depends, Query, UploadFile, File
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field, EmailStr

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALGORITHM = os.environ.get("JWT_ALGORITHM", "HS256")
JWT_EXPIRE_MINUTES = int(os.environ.get("JWT_EXPIRE_MINUTES", "10080"))
BOOTSTRAP_SECRET = os.environ.get("BOOTSTRAP_SECRET", "synco_bootstrap_2026_change_me")
EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

app = FastAPI(title="SynCo v2.0 API")
api = APIRouter(prefix="/api")
bearer = HTTPBearer(auto_error=False)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("synco")


# === Constants =============================================================
ROLE_COORD = "coordinador_general"
ROLE_JEFE = "jefe_proyecto"  # Jefe de Proyecto: lectura global (read-only)
ROLE_SUB = "sub_coordinador"
ROLE_ESPECIALISTA = "especialista"
VALID_ROLES = {ROLE_COORD, ROLE_JEFE, ROLE_SUB, ROLE_ESPECIALISTA}
# Roles que sólo pueden LEER (no escribir / crear / editar nada).
READ_ONLY_ROLES = {ROLE_JEFE}


def _assert_write_allowed(user: dict) -> None:
    """Bloquea operaciones de escritura para roles de sólo lectura.
    Llama esta función al inicio de cualquier endpoint POST/PUT/PATCH/DELETE
    que use `current_user` directamente (sin `require_role`)."""
    if user.get("role") in READ_ONLY_ROLES:
        raise HTTPException(403, "Tu rol es solo de lectura; no puedes realizar esta acción")

MEASUREMENT_TYPES = {"coord_latlon", "cadenamiento", "eje", "nivel"}


def _sanitize_reference_files(items) -> list:
    """Valida y limpia la lista de archivos de referencia.
    Espera una lista de dicts con 'name' y 'url'.
    Descarta entradas vacías o malformadas. Máximo 50 elementos."""
    if not items or not isinstance(items, list):
        return []
    cleaned = []
    for it in items[:50]:
        if not isinstance(it, dict):
            continue
        name = (it.get("name") or "").strip()
        url = (it.get("url") or "").strip()
        if not name or not url:
            continue
        # Limitar tamaños para evitar payloads abusivos
        cleaned.append({"name": name[:200], "url": url[:1000]})
    return cleaned

# Colecciones del esquema v2
COLLECTIONS_V2 = ["users", "projects", "location_nodes", "areas", "invitations", "reports", "announcements", "messages", "events", "channels"]

# Colecciones legacy a eliminar en startup
COLLECTIONS_LEGACY = [
    "activities", "reference_points", "chat_messages", "chat_areas", "chat_area_messages",
    "events", "documents", "site_config", "report_history",
]


# === Models =================================================================
class Token(BaseModel):
    token: str
    user: dict


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class BootstrapIn(BaseModel):
    secret: str
    email: EmailStr
    password: str
    name: str


class UserOut(BaseModel):
    id: str
    email: EmailStr
    name: str
    role: str
    area: Optional[str] = None
    puesto: Optional[str] = None
    scope_node_id: Optional[str] = None
    scope_node_ids: List[str] = Field(default_factory=list)
    project_ids: List[str] = Field(default_factory=list)
    expo_push_tokens: List[str] = Field(default_factory=list)
    created_at: datetime


class PushTokenIn(BaseModel):
    """Payload del cliente Expo para registrar / des-registrar un push token."""
    token: str
    platform: Optional[str] = None  # 'ios' | 'android' | 'web' (informativo)


class ProjectIn(BaseModel):
    name: str
    constructora: str
    contract_number: str
    objeto_contrato: Optional[str] = None  # Descripción institucional del objeto del contrato
    cliente_principal: Optional[str] = None  # Cliente / dependencia que contrata (aparece en portada)
    color_tema: Optional[str] = None  # Color institucional del proyecto (#RRGGBB). Default #003366
    start_date: Optional[str] = None  # ISO date "2026-01-15"
    end_date: Optional[str] = None
    description: Optional[str] = None
    reference_files: Optional[List[dict]] = None  # [{"name": str, "url": str}]
    contratistas_list: Optional[List[str]] = None  # Catálogo dinámico de contratistas
    contratos_list: Optional[List[str]] = None  # Catálogo dinámico de números de contrato
    categorias_personal: Optional[List[str]] = None  # Catálogo de categorías de personal
    categorias_equipo: Optional[List[str]] = None  # Catálogo de categorías de equipo
    constructora_logo: Optional[str] = None  # Base64 (data URI o crudo) del logo institucional


class ProjectPatch(BaseModel):
    """PUT parcial — todos los campos opcionales. No exige name/constructora/contract_number."""
    name: Optional[str] = None
    constructora: Optional[str] = None
    contract_number: Optional[str] = None
    objeto_contrato: Optional[str] = None
    cliente_principal: Optional[str] = None
    color_tema: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    description: Optional[str] = None
    reference_files: Optional[List[dict]] = None
    contratistas_list: Optional[List[str]] = None
    contratos_list: Optional[List[str]] = None
    categorias_personal: Optional[List[str]] = None
    categorias_equipo: Optional[List[str]] = None
    constructora_logo: Optional[str] = None


class ProjectOut(BaseModel):
    id: str
    name: str
    constructora: str
    contract_number: str
    objeto_contrato: Optional[str] = None
    cliente_principal: Optional[str] = None
    color_tema: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    description: Optional[str] = None
    reference_files: List[dict] = Field(default_factory=list)
    contratistas_list: List[str] = Field(default_factory=list)
    contratos_list: List[str] = Field(default_factory=list)
    categorias_personal: List[str] = Field(default_factory=list)
    categorias_equipo: List[str] = Field(default_factory=list)
    created_by: str
    created_at: datetime
    archived: bool = False


class LocationNodeIn(BaseModel):
    project_id: str
    parent_id: Optional[str] = None
    name: str
    order: int = 0
    is_leaf: bool = False
    measurement_type: Optional[Literal["coord_latlon", "cadenamiento", "eje", "nivel"]] = None
    # Coordenadas objetivo dictadas por el Coordinador desde oficina (sólo aplican
    # a nodos hoja con measurement_type == "coord_latlon"). El Especialista las
    # ve en modo solo-lectura al capturar.
    target_lat: Optional[float] = None
    target_lon: Optional[float] = None
    target_elev: Optional[float] = None
    # Meta/objetivo numérico del nodo (p.ej. metros lineales, puntos, etc.).
    # Se utiliza para calcular % de avance vs. última lectura registrada.
    meta: Optional[float] = None


class LocationNodeOut(BaseModel):
    id: str
    project_id: str
    parent_id: Optional[str] = None
    name: str
    depth: int
    order: int
    is_leaf: bool
    measurement_type: Optional[str] = None
    target_lat: Optional[float] = None
    target_lon: Optional[float] = None
    target_elev: Optional[float] = None
    meta: Optional[float] = None
    avance_actual: float = 0.0
    metadata: Optional[dict] = None
    path: List[str] = Field(default_factory=list)  # cadena de ids desde raíz hasta self


class AreaIn(BaseModel):
    project_id: str
    name: str
    color: Optional[str] = "#1E40AF"


class AreaOut(BaseModel):
    id: str
    project_id: str
    name: str
    color: str
    created_at: datetime


class InvitationIn(BaseModel):
    project_id: str
    email: EmailStr
    name: str
    role: Literal["sub_coordinador", "especialista", "jefe_proyecto"]
    # Sub-coordinador: scope_node_id (un nodo padre)
    scope_node_id: Optional[str] = None
    # Especialista: area_id, puesto, scope_node_ids (lista de hojas)
    area_id: Optional[str] = None
    puesto: Optional[str] = None
    scope_node_ids: List[str] = Field(default_factory=list)


class InvitationOut(BaseModel):
    id: str
    token: str
    project_id: str
    project_name: str
    email: EmailStr
    name: str
    role: str
    area_id: Optional[str] = None
    puesto: Optional[str] = None
    scope_node_id: Optional[str] = None
    scope_node_ids: List[str] = Field(default_factory=list)
    status: str  # "pending" | "accepted" | "revoked"
    created_at: datetime
    expires_at: datetime


class AcceptInviteIn(BaseModel):
    token: str
    password: str


class ReportIn(BaseModel):
    project_id: str
    node_id: str  # debe ser hoja
    # Valor de medición (formato depende del measurement_type del nodo)
    measurement_value: dict  # ej: {"lat": 19.43, "lon": -99.13} | {"cadenamiento": "5+100"} | {"eje": "A"} | {"nivel": 12.45}
    area_id: Optional[str] = None
    notes: Optional[str] = None
    avance: Optional[str] = None
    observaciones: Optional[str] = None
    incidencias: Optional[str] = None  # Notas sobre eventos/desviaciones del día
    severidad: Optional[Literal["informativo", "importante", "urgente"]] = "informativo"
    contratista: Optional[str] = None
    personnel: List[str] = Field(default_factory=list)
    equipment: List[str] = Field(default_factory=list)
    images: List[str] = Field(default_factory=list)  # base64
    files: List[dict] = Field(default_factory=list)  # [{filename, mime, data_base64}]
    # Lecturas numéricas (P/U) – específicas del flujo Especialista v2.
    primera_lectura: Optional[float] = None
    ultima_lectura: Optional[float] = None
    # Unidad de las lecturas (km | m | cm). Default = "m".
    unidad: Optional[str] = "m"


class ReportOut(BaseModel):
    id: str
    project_id: str
    node_id: str
    node_path_names: List[str]
    node_path_ids: List[str] = Field(default_factory=list)  # ids ancestrales para filtros
    measurement_type: str
    measurement_value: dict
    area_id: Optional[str] = None
    area_name: Optional[str] = None
    notes: Optional[str] = None
    avance: Optional[str] = None
    observaciones: Optional[str] = None
    incidencias: Optional[str] = None
    severidad: str = "informativo"
    contratista: Optional[str] = None
    personnel: List[str] = Field(default_factory=list)
    equipment: List[str] = Field(default_factory=list)
    images: List[str] = Field(default_factory=list)
    files: List[dict] = Field(default_factory=list)
    primera_lectura: Optional[float] = None
    ultima_lectura: Optional[float] = None
    unidad: Optional[str] = "m"
    captured_by: str
    captured_by_name: str
    created_at: datetime


# === Helpers ================================================================
def hash_pw(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=10)).decode()


def verify_pw(pw: str, h: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), h.encode())
    except Exception:
        return False


def make_token(user_id: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRE_MINUTES)
    return jwt.encode({"sub": user_id, "exp": exp}, JWT_SECRET, algorithm=JWT_ALGORITHM)


async def current_user(creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer)) -> dict:
    if not creds:
        raise HTTPException(401, "Token requerido")
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        uid = payload.get("sub")
    except jwt.PyJWTError:
        raise HTTPException(401, "Token inválido")
    u = await db.users.find_one({"id": uid})
    if not u:
        raise HTTPException(401, "Usuario no existe")
    u.pop("_id", None)
    u.pop("password", None)
    return u


def require_role(*allowed_roles: str):
    async def dep(user: dict = Depends(current_user)) -> dict:
        if user["role"] not in allowed_roles:
            raise HTTPException(403, f"Rol no autorizado: {user['role']}")
        return user
    return dep


def user_to_out(u: dict) -> dict:
    return {
        "id": u["id"],
        "email": u["email"],
        "name": u["name"],
        "role": u["role"],
        "area": u.get("area"),
        "puesto": u.get("puesto"),
        "scope_node_id": u.get("scope_node_id"),
        "scope_node_ids": u.get("scope_node_ids") or [],
        "project_ids": u.get("project_ids") or [],
        "expo_push_tokens": u.get("expo_push_tokens") or [],
        "created_at": u.get("created_at", datetime.now(timezone.utc)),
    }


async def ensure_project_access(user: dict, project_id: str) -> dict:
    """Valida que el usuario tenga acceso a un proyecto; devuelve el proyecto."""
    p = await db.projects.find_one({"id": project_id, "archived": {"$ne": True}})
    if not p:
        raise HTTPException(404, "Proyecto no existe")
    if user["role"] in (ROLE_COORD, ROLE_JEFE):
        return p  # acceso global (Coordinador General y Jefe de Proyecto)
    if project_id not in (user.get("project_ids") or []):
        raise HTTPException(403, "Sin acceso a este proyecto")
    return p


async def build_node_path(node: dict) -> List[str]:
    """Devuelve la cadena de IDs desde raíz hasta self (incluido)."""
    path = [node["id"]]
    cur = node
    while cur.get("parent_id"):
        parent = await db.location_nodes.find_one({"id": cur["parent_id"]})
        if not parent:
            break
        path.insert(0, parent["id"])
        cur = parent
    return path


async def node_path_names(node_id: str) -> List[str]:
    node = await db.location_nodes.find_one({"id": node_id})
    if not node:
        return []
    ids = await build_node_path(node)
    names: List[str] = []
    for nid in ids:
        n = await db.location_nodes.find_one({"id": nid})
        if n:
            names.append(n["name"])
    return names


async def descendants_ids(root_id: str) -> List[str]:
    """Devuelve TODOS los descendientes (incluyendo root_id) de un nodo."""
    out = [root_id]
    queue = [root_id]
    while queue:
        pid = queue.pop(0)
        children = await db.location_nodes.find({"parent_id": pid}).to_list(length=10000)
        for c in children:
            out.append(c["id"])
            queue.append(c["id"])
    return out


# === Startup: wipe legacy ===================================================
@app.on_event("startup")
async def startup_event():
    # Eliminar colecciones legacy de la versión anterior
    existing = await db.list_collection_names()
    for c in COLLECTIONS_LEGACY:
        if c in existing:
            await db[c].drop()
            log.info(f"[wipe] Dropped legacy collection: {c}")
    # Indexes esenciales
    await db.users.create_index("email", unique=True)
    await db.invitations.create_index("token", unique=True)
    await db.location_nodes.create_index([("project_id", 1), ("parent_id", 1)])
    await db.reports.create_index([("project_id", 1), ("created_at", -1)])
    await db.announcements.create_index([("project_id", 1), ("pinned", -1), ("created_at", -1)])
    await db.messages.create_index([("project_id", 1), ("created_at", -1)])
    await db.messages.create_index([("channel_id", 1), ("created_at", -1)])
    await db.events.create_index([("project_id", 1), ("start_at", 1)])
    await db.channels.create_index([("project_id", 1), ("type", 1)])
    await db.channels.create_index([("project_id", 1), ("type", 1), ("area_id", 1)])
    await db.channels.create_index([("project_id", 1), ("type", 1), ("member_ids", 1)])

    # --- Migración one-shot: asegurar canal General + asignar channel_id a
    # mensajes legacy creados antes del refactor de canales.
    try:
        legacy_msgs = await db.messages.count_documents({"channel_id": {"$exists": False}})
        if legacy_msgs:
            log.info(f"[migrate] {legacy_msgs} mensajes legacy sin channel_id → asignando a General de cada proyecto")
            project_ids = await db.messages.distinct("project_id", {"channel_id": {"$exists": False}})
            for pid in project_ids:
                if not pid:
                    continue
                await _ensure_default_channels(pid)
                g = await db.channels.find_one({"project_id": pid, "type": "general"})
                if g:
                    await db.messages.update_many(
                        {"project_id": pid, "channel_id": {"$exists": False}},
                        {"$set": {"channel_id": g["id"]}},
                    )
            log.info("[migrate] mensajes legacy migrados al canal General")
    except Exception as e:
        log.warning(f"[migrate] error migrando mensajes legacy: {e}")
    log.info("[startup] SynCo v2.0 ready")


# === ROOT / HEALTH ==========================================================
@api.get("/")
async def root():
    return {"name": "SynCo v2.0", "status": "ok"}


@api.get("/health")
async def health():
    return {"ok": True, "ts": datetime.now(timezone.utc).isoformat()}


# === BOOTSTRAP (idempotente) ================================================
@api.post("/admin/bootstrap")
async def bootstrap(body: BootstrapIn):
    if body.secret != BOOTSTRAP_SECRET:
        raise HTTPException(403, "Secret inválido")
    existing = await db.users.find_one({"email": body.email.lower()})
    if existing:
        # Idempotente: si ya existe y es coordinador_general, OK
        if existing.get("role") != ROLE_COORD:
            raise HTTPException(409, "Email existe con otro rol")
        return {"ok": True, "user": user_to_out(existing), "created": False}
    uid = str(uuid.uuid4())
    user = {
        "id": uid,
        "email": body.email.lower(),
        "password": hash_pw(body.password),
        "name": body.name,
        "role": ROLE_COORD,
        "created_at": datetime.now(timezone.utc),
        "project_ids": [],
    }
    await db.users.insert_one(user)
    log.info(f"[bootstrap] Created coordinador_general {body.email}")
    return {"ok": True, "user": user_to_out(user), "created": True}


# === COORDINADORES GENERALES (gestión por pares) ============================
class CoordinatorCreateIn(BaseModel):
    name: str
    email: EmailStr
    password: str


@api.get("/admin/coordinators")
async def list_coordinators(user: dict = Depends(require_role(ROLE_COORD))):
    """Lista todos los Coordinadores Generales. Sólo accesible por otro
    Coordinador General. Devuelve el directorio con email, nombre y fecha
    de alta para auditoría."""
    items = await db.users.find({"role": ROLE_COORD}).sort("created_at", 1).to_list(length=500)
    return [user_to_out(u) for u in items]


@api.post("/admin/coordinators")
async def create_coordinator(
    body: CoordinatorCreateIn,
    user: dict = Depends(require_role(ROLE_COORD)),
):
    """Crea un nuevo Coordinador General. Sólo un Coordinador General
    autenticado puede ejecutar esta acción. El nuevo usuario hereda los
    mismos privilegios globales (gobierna cualquier proyecto)."""
    name = (body.name or "").strip()
    email = (body.email or "").strip().lower()
    pw = (body.password or "").strip()
    if not name:
        raise HTTPException(400, "Nombre requerido")
    if len(name) > 80:
        raise HTTPException(400, "Nombre máximo 80 caracteres")
    if not email:
        raise HTTPException(400, "Email requerido")
    if len(pw) < 6:
        raise HTTPException(400, "Contraseña mínima de 6 caracteres")
    if await db.users.find_one({"email": email}):
        raise HTTPException(409, "Ya existe un usuario con ese email")
    uid = str(uuid.uuid4())
    doc = {
        "id": uid,
        "email": email,
        "password": hash_pw(pw),
        "name": name,
        "role": ROLE_COORD,
        "created_at": datetime.now(timezone.utc),
        "project_ids": [],
        "created_by": user["id"],
    }
    await db.users.insert_one(doc)
    log.info(f"[admin] Coord {user['email']} created new coordinador_general {email}")
    return user_to_out(doc)


# === AUTH ===================================================================
@api.post("/auth/login", response_model=Token)
async def login(body: LoginIn):
    u = await db.users.find_one({"email": body.email.lower()})
    if not u or not verify_pw(body.password, u["password"]):
        raise HTTPException(401, "Credenciales inválidas")
    return {"token": make_token(u["id"]), "user": user_to_out(u)}


@api.get("/auth/me")
async def me(user: dict = Depends(current_user)):
    return user_to_out(user)


# === PUSH NOTIFICATIONS (Expo) ==============================================
import httpx  # local import is safe — module-level top imports remain authoritative

EXPO_PUSH_API_URL = "https://exp.host/--/api/v2/push/send"


def _is_valid_expo_token(token: str) -> bool:
    """
    Valida el formato de un Expo push token.
    Formato oficial: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' o 'ExpoPushToken[...]'.
    """
    if not token or not isinstance(token, str):
        return False
    t = token.strip()
    if not (t.startswith("ExponentPushToken[") or t.startswith("ExpoPushToken[")):
        return False
    if not t.endswith("]"):
        return False
    if len(t) > 200:  # defensive cap
        return False
    return True


@api.post("/users/push-token")
async def register_push_token(
    body: PushTokenIn,
    user: dict = Depends(current_user),
):
    """
    Registra un Expo Push Token en el perfil del usuario autenticado.
    - Usa $addToSet para evitar duplicados.
    - Limita el array a 10 tokens (FIFO) para no acumular dispositivos viejos.
    """
    token = (body.token or "").strip()
    if not _is_valid_expo_token(token):
        raise HTTPException(400, "Token de Expo inválido")

    # Add to set (no duplicates).
    await db.users.update_one(
        {"id": user["id"]},
        {"$addToSet": {"expo_push_tokens": token}},
    )

    # FIFO cap @ 10 tokens — keep only the most recent ones.
    fresh = await db.users.find_one(
        {"id": user["id"]}, {"_id": 0, "expo_push_tokens": 1}
    )
    tokens_list = (fresh or {}).get("expo_push_tokens") or []
    if len(tokens_list) > 10:
        trimmed = tokens_list[-10:]
        await db.users.update_one(
            {"id": user["id"]},
            {"$set": {"expo_push_tokens": trimmed}},
        )
        tokens_list = trimmed

    logger_count = len(tokens_list)
    log.info(
        "[push] token registered user=%s platform=%s total_tokens=%d",
        user.get("email"),
        body.platform or "unknown",
        logger_count,
    )
    return {"ok": True, "count": logger_count}


@api.delete("/users/push-token")
async def unregister_push_token(
    body: PushTokenIn,
    user: dict = Depends(current_user),
):
    """Elimina un Expo push token del perfil del usuario (logout / device removal)."""
    token = (body.token or "").strip()
    if not token:
        raise HTTPException(400, "Token vacío")
    await db.users.update_one(
        {"id": user["id"]},
        {"$pull": {"expo_push_tokens": token}},
    )
    return {"ok": True}


async def send_push_notification(
    user_id: str,
    title: str,
    body: str,
    data: Optional[dict] = None,
    sound: Optional[str] = "default",
    priority: str = "high",
) -> dict:
    """
    Envía una notificación push a TODOS los Expo push tokens registrados del usuario.

    Esta función está **definida y lista para usarse**, pero NO se vincula a ningún
    evento todavía. Es responsabilidad del feature que la consuma (e.g. nuevo reporte,
    mensaje en chat, asignación de tarea) llamarla.

    Args:
        user_id: ID del usuario destinatario.
        title:   Título de la notificación.
        body:    Cuerpo / mensaje principal.
        data:    Payload opcional para deep-linking (e.g. {"report_id": "..."}).
        sound:   'default' o None.
        priority: 'default' | 'normal' | 'high'.

    Returns:
        dict con shape:
        {
          "ok": bool,
          "sent": int,            # cuántos mensajes se intentaron enviar
          "failed_tokens": [str], # tokens que Expo reportó como inválidos
          "response": <expo raw json or error string>,
        }
    """
    u = await db.users.find_one({"id": user_id}, {"_id": 0, "expo_push_tokens": 1})
    tokens: list = (u or {}).get("expo_push_tokens") or []
    if not tokens:
        return {"ok": False, "sent": 0, "failed_tokens": [], "response": "no tokens"}

    # Build the Expo push message batch (Expo accepts a JSON array).
    messages = []
    for t in tokens:
        if not _is_valid_expo_token(t):
            continue
        msg = {
            "to": t,
            "title": title,
            "body": body,
            "priority": priority,
        }
        if sound:
            msg["sound"] = sound
        if data:
            msg["data"] = data
        messages.append(msg)

    if not messages:
        return {"ok": False, "sent": 0, "failed_tokens": tokens, "response": "no valid tokens"}

    headers = {
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
    }

    failed_tokens: list = []
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(EXPO_PUSH_API_URL, json=messages, headers=headers)
            try:
                payload = r.json()
            except Exception:
                payload = {"raw": r.text}

            # Expo returns {"data": [{"status":"ok"|"error","id":"...","message":"...","details":{"error":"DeviceNotRegistered"}}, ...]}
            results = (payload or {}).get("data") or []
            for idx, item in enumerate(results):
                if isinstance(item, dict) and item.get("status") == "error":
                    err = (item.get("details") or {}).get("error", "")
                    if err in ("DeviceNotRegistered", "InvalidCredentials"):
                        if idx < len(messages):
                            failed_tokens.append(messages[idx]["to"])

            # Auto-clean: remove invalid tokens from user's profile.
            if failed_tokens:
                await db.users.update_one(
                    {"id": user_id},
                    {"$pull": {"expo_push_tokens": {"$in": failed_tokens}}},
                )

            return {
                "ok": r.status_code < 400,
                "sent": len(messages),
                "failed_tokens": failed_tokens,
                "response": payload,
            }
    except Exception as exc:  # pragma: no cover - defensive
        log.exception("[push] send_push_notification failed: %s", exc)
        return {
            "ok": False,
            "sent": 0,
            "failed_tokens": [],
            "response": f"exception: {exc}",
        }


# === PROJECTS ===============================================================
def _sanitize_str_list(items, max_items: int = 200, max_len: int = 200) -> list:
    """Limpia listas de strings (contratistas / contratos). Dedup case-insensitive."""
    if not items or not isinstance(items, list):
        return []
    out: list = []
    seen: set = set()
    for it in items:
        if not isinstance(it, str):
            continue
        s = it.strip()
        if not s:
            continue
        if len(s) > max_len:
            s = s[:max_len]
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
        if len(out) >= max_items:
            break
    return out


def _sanitize_color_hex(value: Optional[str]) -> Optional[str]:
    """Valida un color hex `#RRGGBB` o `#RGB`. Devuelve `#RRGGBB` en mayúsculas o None."""
    if not value or not isinstance(value, str):
        return None
    s = value.strip().lstrip("#")
    if len(s) == 3 and all(ch in "0123456789abcdefABCDEF" for ch in s):
        s = "".join(ch * 2 for ch in s)
    if len(s) != 6 or any(ch not in "0123456789abcdefABCDEF" for ch in s):
        return None
    return "#" + s.upper()


@api.get("/projects")
async def list_projects(user: dict = Depends(current_user)):
    if user["role"] in (ROLE_COORD, ROLE_JEFE):
        # Coordinador General y Jefe de Proyecto: acceso global a todos los proyectos.
        cursor = db.projects.find({"archived": {"$ne": True}}).sort("created_at", -1)
    else:
        pids = user.get("project_ids") or []
        cursor = db.projects.find({"id": {"$in": pids}, "archived": {"$ne": True}}).sort("created_at", -1)
    items = await cursor.to_list(length=500)
    for it in items:
        it.pop("_id", None)
        it.setdefault("contratistas_list", [])
        it.setdefault("contratos_list", [])
    return items


@api.post("/projects")
async def create_project(body: ProjectIn, user: dict = Depends(require_role(ROLE_COORD))):
    pid = str(uuid.uuid4())
    doc = {
        "id": pid,
        "name": body.name.strip(),
        "constructora": body.constructora.strip(),
        "contract_number": body.contract_number.strip(),
        "objeto_contrato": (body.objeto_contrato or "").strip() or None,
        "cliente_principal": (body.cliente_principal or "").strip() or None,
        "color_tema": _sanitize_color_hex(body.color_tema) or "#003366",
        "start_date": body.start_date,
        "end_date": body.end_date,
        "description": (body.description or "").strip() or None,
        "reference_files": _sanitize_reference_files(body.reference_files),
        "contratistas_list": _sanitize_str_list(body.contratistas_list),
        "contratos_list": _sanitize_str_list(body.contratos_list),
        "categorias_personal": _sanitize_str_list(body.categorias_personal),
        "categorias_equipo": _sanitize_str_list(body.categorias_equipo),
        "created_by": user["id"],
        "created_at": datetime.now(timezone.utc),
        "archived": False,
    }
    await db.projects.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api.get("/projects/{pid}")
async def get_project(pid: str, user: dict = Depends(current_user)):
    p = await ensure_project_access(user, pid)
    p.pop("_id", None)
    p.setdefault("reference_files", [])
    p.setdefault("contratistas_list", [])
    p.setdefault("contratos_list", [])
    p.setdefault("categorias_personal", [])
    p.setdefault("categorias_equipo", [])
    p.setdefault("objeto_contrato", None)
    p.setdefault("cliente_principal", None)
    p.setdefault("color_tema", "#003366")
    return p


@api.put("/projects/{pid}")
async def update_project(pid: str, body: ProjectPatch, user: dict = Depends(require_role(ROLE_COORD))):
    """PATCH parcial: sólo actualiza los campos enviados.

    Permite, por ejemplo, actualizar únicamente `objeto_contrato` o catálogos
    sin tener que reenviar name/constructora/contract_number.
    """
    existing = await db.projects.find_one({"id": pid})
    if not existing:
        raise HTTPException(404, "Proyecto no existe")

    upd: dict = {}
    if body.name is not None:
        n = body.name.strip()
        if n:
            upd["name"] = n
    if body.constructora is not None:
        upd["constructora"] = body.constructora.strip()
    if body.contract_number is not None:
        upd["contract_number"] = body.contract_number.strip()
    if body.objeto_contrato is not None:
        upd["objeto_contrato"] = body.objeto_contrato.strip() or None
    if body.cliente_principal is not None:
        upd["cliente_principal"] = body.cliente_principal.strip() or None
    if body.color_tema is not None:
        upd["color_tema"] = _sanitize_color_hex(body.color_tema) or "#003366"
    if body.start_date is not None:
        upd["start_date"] = body.start_date
    if body.end_date is not None:
        upd["end_date"] = body.end_date
    if body.description is not None:
        upd["description"] = body.description.strip() or None
    if body.reference_files is not None:
        upd["reference_files"] = _sanitize_reference_files(body.reference_files)
    if body.contratistas_list is not None:
        upd["contratistas_list"] = _sanitize_str_list(body.contratistas_list)
    if body.contratos_list is not None:
        upd["contratos_list"] = _sanitize_str_list(body.contratos_list)
    if body.categorias_personal is not None:
        upd["categorias_personal"] = _sanitize_str_list(body.categorias_personal)
    if body.categorias_equipo is not None:
        upd["categorias_equipo"] = _sanitize_str_list(body.categorias_equipo)
    if body.constructora_logo is not None:
        # Aceptamos cadena vacía para "limpiar" el logo
        upd["constructora_logo"] = body.constructora_logo or None

    if upd:
        await db.projects.update_one({"id": pid}, {"$set": upd})

    p = await db.projects.find_one({"id": pid})
    p.pop("_id", None)
    p.setdefault("reference_files", [])
    p.setdefault("contratistas_list", [])
    p.setdefault("contratos_list", [])
    p.setdefault("categorias_personal", [])
    p.setdefault("categorias_equipo", [])
    p.setdefault("objeto_contrato", None)
    p.setdefault("cliente_principal", None)
    p.setdefault("color_tema", "#003366")
    return p


@api.put("/projects/{pid}/catalogos")
async def set_project_catalogos(
    pid: str,
    body: dict,
    user: dict = Depends(require_role(ROLE_COORD)),
):
    """Actualiza catálogos dinámicos del proyecto:
    contratistas_list, contratos_list, categorias_personal y categorias_equipo.
    Sólo Coordinador General puede modificarlos."""
    upd: dict = {}
    if isinstance(body.get("contratistas_list"), list):
        upd["contratistas_list"] = _sanitize_str_list(body.get("contratistas_list"))
    if isinstance(body.get("contratos_list"), list):
        upd["contratos_list"] = _sanitize_str_list(body.get("contratos_list"))
    if isinstance(body.get("categorias_personal"), list):
        upd["categorias_personal"] = _sanitize_str_list(body.get("categorias_personal"))
    if isinstance(body.get("categorias_equipo"), list):
        upd["categorias_equipo"] = _sanitize_str_list(body.get("categorias_equipo"))
    if not upd:
        raise HTTPException(400, "Nada para actualizar")
    r = await db.projects.update_one({"id": pid}, {"$set": upd})
    if r.matched_count == 0:
        raise HTTPException(404, "Proyecto no existe")
    p = await db.projects.find_one({"id": pid})
    p.pop("_id", None)
    p.setdefault("reference_files", [])
    p.setdefault("contratistas_list", [])
    p.setdefault("contratos_list", [])
    p.setdefault("categorias_personal", [])
    p.setdefault("categorias_equipo", [])
    p.setdefault("objeto_contrato", None)
    p.setdefault("cliente_principal", None)
    p.setdefault("color_tema", "#003366")
    return p


@api.delete("/projects/{pid}")
async def archive_project(pid: str, user: dict = Depends(require_role(ROLE_COORD))):
    await db.projects.update_one({"id": pid}, {"$set": {"archived": True}})
    return {"ok": True, "archived": True}


class ReferenceFilesIn(BaseModel):
    reference_files: List[dict] = Field(default_factory=list)


@api.put("/projects/{pid}/reference-files")
async def set_reference_files(
    pid: str,
    body: ReferenceFilesIn,
    user: dict = Depends(require_role(ROLE_COORD)),
):
    """Actualiza la lista completa de Archivos de Consulta del proyecto.
    Sólo Coordinador General puede modificar esta lista."""
    cleaned = _sanitize_reference_files(body.reference_files)
    r = await db.projects.update_one(
        {"id": pid}, {"$set": {"reference_files": cleaned}}
    )
    if r.matched_count == 0:
        raise HTTPException(404, "Proyecto no existe")
    return {"ok": True, "reference_files": cleaned}


# === LOCATION NODES (Árbol Recursivo) =======================================
@api.get("/projects/{pid}/nodes")
async def list_nodes(pid: str, user: dict = Depends(current_user)):
    await ensure_project_access(user, pid)
    items = await db.location_nodes.find({"project_id": pid}).sort([("depth", 1), ("order", 1)]).to_list(length=10000)

    # --- FIX AMNESIA DE ESTADO: usar MAX(ultima_lectura) numérica, no SUM(avance) texto ---
    pipeline = [
        {"$match": {"project_id": pid, "ultima_lectura": {"$ne": None}}},
        {"$group": {"_id": "$node_id", "total_avance": {"$max": "$ultima_lectura"}}},
    ]
    aggr = await db.reports.aggregate(pipeline).to_list(length=10000)
    avances_dict = {doc["_id"]: float(doc.get("total_avance") or 0.0) for doc in aggr}
    # -------------------------------------------------------------------------------------

    # Filtrado por scope (Sub-coordinador AHORA tiene scope GLOBAL, igual que Coordinador).
    role = user.get("role")
    if role == ROLE_ESPECIALISTA and (user.get("scope_node_ids") or []):
        allowed_leaves = set(user.get("scope_node_ids") or [])
        # incluir ancestros para que el árbol sea navegable
        ancestors: set = set()
        # construir mapa id->parent
        all_nodes = await db.location_nodes.find({"project_id": pid}).to_list(length=10000)
        parent_of = {n["id"]: n.get("parent_id") for n in all_nodes}
        for leaf in allowed_leaves:
            cur = leaf
            while cur:
                ancestors.add(cur)
                cur = parent_of.get(cur)
        items = [it for it in items if it["id"] in ancestors]
        
    for it in items:
        it.pop("_id", None)
        # Inyectamos el acumulado al nodo
        it["avance_actual"] = avances_dict.get(it["id"], 0.0)
        
    return items


@api.get("/projects/{pid}/nodes/tree")
async def get_tree(pid: str, user: dict = Depends(current_user)):
    """Devuelve el árbol completo como estructura jerárquica."""
    await ensure_project_access(user, pid)
    items = await db.location_nodes.find({"project_id": pid}).sort([("depth", 1), ("order", 1)]).to_list(length=10000)
    
    # --- FIX AMNESIA DE ESTADO: usar MAX(ultima_lectura) numérica, no SUM(avance) texto ---
    pipeline = [
        {"$match": {"project_id": pid, "ultima_lectura": {"$ne": None}}},
        {"$group": {"_id": "$node_id", "total_avance": {"$max": "$ultima_lectura"}}},
    ]
    aggr = await db.reports.aggregate(pipeline).to_list(length=10000)
    avances_dict = {doc["_id"]: float(doc.get("total_avance") or 0.0) for doc in aggr}
    # -------------------------------------------------------------------------------------

    # Filtrado por scope (Sub-coordinador AHORA tiene scope GLOBAL, igual que Coordinador).
    role = user.get("role")
    if role == ROLE_ESPECIALISTA and (user.get("scope_node_ids") or []):
        allowed_leaves = set(user.get("scope_node_ids") or [])
        ancestors: set = set()
        parent_of = {n["id"]: n.get("parent_id") for n in items}
        for leaf in allowed_leaves:
            cur = leaf
            while cur:
                ancestors.add(cur)
                cur = parent_of.get(cur)
        items = [it for it in items if it["id"] in ancestors]
        
    by_id = {}
    for it in items:
        it.pop("_id", None)
        # Inyectamos el acumulado al nodo antes de anidarlo
        it["avance_actual"] = avances_dict.get(it["id"], 0.0)
        it["children"] = []
        by_id[it["id"]] = it
        
    roots = []
    # Para sub-coord/especialista, "root" debe ser el primer nodo cuyo padre no está en el set filtrado
    for it in items:
        if it.get("parent_id") and it["parent_id"] in by_id:
            by_id[it["parent_id"]]["children"].append(it)
        else:
            roots.append(it)
    return roots


@api.post("/projects/{pid}/nodes")
async def create_node(pid: str, body: LocationNodeIn, user: dict = Depends(require_role(ROLE_COORD))):
    if body.project_id != pid:
        raise HTTPException(400, "project_id mismatch")
    await ensure_project_access(user, pid)
    parent = None
    depth = 0
    if body.parent_id:
        parent = await db.location_nodes.find_one({"id": body.parent_id, "project_id": pid})
        if not parent:
            raise HTTPException(404, "Nodo padre no existe")
        depth = parent["depth"] + 1
        # Si el padre era hoja, deja de serlo automáticamente.
        if parent.get("is_leaf"):
            await db.location_nodes.update_one(
                {"id": parent["id"]},
                {"$set": {"is_leaf": False, "measurement_type": None, "target_lat": None, "target_lon": None, "target_elev": None}},
            )
    if body.is_leaf and body.measurement_type not in MEASUREMENT_TYPES:
        raise HTTPException(400, "Nodos hoja requieren measurement_type válido")
    nid = str(uuid.uuid4())
    # Coordenadas objetivo: sólo aplican a hojas coord_latlon.
    is_coord_leaf = body.is_leaf and body.measurement_type == "coord_latlon"
    doc = {
        "id": nid,
        "project_id": pid,
        "parent_id": body.parent_id,
        "name": body.name.strip(),
        "depth": depth,
        "order": body.order,
        "is_leaf": body.is_leaf,
        "measurement_type": body.measurement_type if body.is_leaf else None,
        "target_lat": body.target_lat if is_coord_leaf else None,
        "target_lon": body.target_lon if is_coord_leaf else None,
        "target_elev": body.target_elev if is_coord_leaf else None,
        "meta": body.meta if body.is_leaf else None,
        "created_at": datetime.now(timezone.utc),
    }
    await db.location_nodes.insert_one(doc)
    doc.pop("_id", None)
    return doc


class NodePatch(BaseModel):
    name: Optional[str] = None
    order: Optional[int] = None
    is_leaf: Optional[bool] = None
    measurement_type: Optional[Literal["coord_latlon", "cadenamiento", "eje", "nivel"]] = None
    target_lat: Optional[float] = None
    target_lon: Optional[float] = None
    target_elev: Optional[float] = None
    meta: Optional[float] = None


@api.patch("/nodes/{nid}")
async def update_node(nid: str, body: NodePatch, user: dict = Depends(require_role(ROLE_COORD, ROLE_SUB))):
    node = await db.location_nodes.find_one({"id": nid})
    if not node:
        raise HTTPException(404, "Nodo no existe")
    upd: dict = {}
    if body.name is not None:
        upd["name"] = body.name.strip()
    if body.order is not None:
        upd["order"] = body.order
    if body.is_leaf is not None:
        if body.is_leaf:
            # Para convertirse en hoja no debe tener hijos
            has_children = await db.location_nodes.find_one({"parent_id": nid})
            if has_children:
                raise HTTPException(400, "No se puede marcar como hoja: tiene hijos")
            if body.measurement_type not in MEASUREMENT_TYPES:
                raise HTTPException(400, "Hoja requiere measurement_type")
            upd["is_leaf"] = True
            upd["measurement_type"] = body.measurement_type
        else:
            upd["is_leaf"] = False
            upd["measurement_type"] = None
            upd["target_lat"] = None
            upd["target_lon"] = None
            upd["target_elev"] = None
    elif body.measurement_type is not None:
        if not node.get("is_leaf"):
            raise HTTPException(400, "measurement_type solo aplica a hojas")
        if body.measurement_type not in MEASUREMENT_TYPES:
            raise HTTPException(400, "measurement_type inválido")
        upd["measurement_type"] = body.measurement_type
        # Si cambia el tipo y deja de ser coord_latlon, limpia coords objetivo.
        if body.measurement_type != "coord_latlon":
            upd["target_lat"] = None
            upd["target_lon"] = None
            upd["target_elev"] = None
    # Coordenadas objetivo (sólo válidas en hojas coord_latlon — usar valor final).
    final_is_leaf = upd.get("is_leaf", node.get("is_leaf"))
    final_mtype = upd.get("measurement_type", node.get("measurement_type"))
    is_coord_leaf = bool(final_is_leaf and final_mtype == "coord_latlon")
    for fld, val in (("target_lat", body.target_lat), ("target_lon", body.target_lon), ("target_elev", body.target_elev)):
        if val is not None and is_coord_leaf:
            upd[fld] = val
    # Meta numérica: válida sólo para nodos hoja; si se manda en no-hoja se ignora.
    if body.meta is not None:
        if final_is_leaf:
            upd["meta"] = float(body.meta)
        # Si el nodo deja de ser hoja, limpiamos meta más abajo.
    if upd.get("is_leaf") is False:
        upd["meta"] = None
    if upd:
        await db.location_nodes.update_one({"id": nid}, {"$set": upd})
    out = await db.location_nodes.find_one({"id": nid})
    out.pop("_id", None)
    return out


@api.delete("/nodes/{nid}")
async def delete_node(nid: str, user: dict = Depends(require_role(ROLE_COORD))):
    node = await db.location_nodes.find_one({"id": nid})
    if not node:
        raise HTTPException(404, "Nodo no existe")
    ids_to_delete = await descendants_ids(nid)
    await db.location_nodes.delete_many({"id": {"$in": ids_to_delete}})
    # NO borramos reportes huérfanos automáticamente (preservación). Marcar como huérfanos:
    await db.reports.update_many(
        {"node_id": {"$in": ids_to_delete}}, {"$set": {"node_orphan": True}}
    )
    return {"ok": True, "deleted_count": len(ids_to_delete)}


# === BULK UPLOAD GENÉRICO DE NODOS DESDE EXCEL/CSV =========================
# Columnas reconocidas dinámicamente:
#   - Nombre del nodo: "nombre", "nodo", "nombre del nodo", "nombre del poste"
#     (case-insensitive, sin acentos). Si no se encuentra, se usa la 1ra columna.
#   - Padre (opcional, jerarquía): "padre", "nodo padre", "parent"
#   - Resto de columnas: se guardan tal cual dentro de `metadata` (dict).
#
# Reglas:
#   - Filas con nombre vacío se ignoran.
#   - Upsert por (project_id, name) case-insensitive. Si existe -> actualiza
#     metadata y parent_id; si no -> crea como nodo no-hoja.
#   - Las filas se procesan en orden: primero los nodos sin padre, después
#     los hijos (dos pasadas) para resolver referencias forward.

_NODE_NAME_CANDIDATES = {
    "nombre", "nodo", "nombre del nodo", "nombre del poste",
    "name", "node", "node name",
}
_NODE_PARENT_CANDIDATES = {
    "padre", "nodo padre", "parent", "padre id", "parent id",
}


def _normalize_col(s: str) -> str:
    """Normaliza un encabezado para comparación (lower, sin acentos, sin espacios extra)."""
    if not isinstance(s, str):
        return ""
    s = s.strip().lower()
    repl = {"á": "a", "é": "e", "í": "i", "ó": "o", "ú": "u", "ñ": "n"}
    for k, v in repl.items():
        s = s.replace(k, v)
    return s


def _coerce_cell(v):
    """Convierte celdas de pandas en algo serializable y limpio.
    Ignora NaN/None, recorta strings."""
    try:
        import math
        if v is None:
            return None
        if isinstance(v, float) and math.isnan(v):
            return None
    except Exception:
        pass
    if isinstance(v, str):
        s = v.strip()
        return s if s else None
    return v


@api.get("/projects/{pid}/nodes/bulk-upload/template")
async def bulk_upload_template(
    pid: str,
    user: dict = Depends(require_role(ROLE_COORD)),
):
    """Devuelve una plantilla .xlsx de ejemplo para carga masiva de nodos.

    Columnas:
      - Nombre: nombre del nodo (obligatorio)
      - Padre: nombre del nodo padre (opcional; deja vacío para nodos raíz)
      - Coordenada X, Coordenada Y, Elevación (TN), Dirección: ejemplos de metadatos.
    """
    await ensure_project_access(user, pid)
    try:
        import pandas as pd  # noqa: WPS433
    except Exception as e:  # pragma: no cover
        raise HTTPException(500, f"pandas no disponible: {e}")

    sample = [
        {
            "Nombre": "Tramo 1",
            "Padre": "",
            "Coordenada X": "",
            "Coordenada Y": "",
            "Elevación (TN)": "",
            "Dirección": "Tronco principal",
        },
        {
            "Nombre": "P-101",
            "Padre": "Tramo 1",
            "Coordenada X": 19.432608,
            "Coordenada Y": -99.133209,
            "Elevación (TN)": 2240.5,
            "Dirección": "Av. Reforma 100",
        },
        {
            "Nombre": "P-102",
            "Padre": "Tramo 1",
            "Coordenada X": 19.433100,
            "Coordenada Y": -99.134000,
            "Elevación (TN)": 2241.0,
            "Dirección": "Av. Reforma 120",
        },
        {
            "Nombre": "Tramo 2",
            "Padre": "",
            "Coordenada X": "",
            "Coordenada Y": "",
            "Elevación (TN)": "",
            "Dirección": "Ramal secundario",
        },
        {
            "Nombre": "P-201",
            "Padre": "Tramo 2",
            "Coordenada X": 19.440100,
            "Coordenada Y": -99.145000,
            "Elevación (TN)": 2245.2,
            "Dirección": "Calz. Tlalpan 500",
        },
    ]
    df = pd.DataFrame(sample)

    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="Nodos", index=False)
        # Ajustar ancho de columnas para que sea legible
        ws = writer.sheets["Nodos"]
        widths = {"A": 22, "B": 22, "C": 16, "D": 16, "E": 18, "F": 32}
        for col, w in widths.items():
            ws.column_dimensions[col].width = w
    buf.seek(0)

    headers = {
        "Content-Disposition": 'attachment; filename="plantilla_nodos_synco.xlsx"',
    }
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


@api.post("/projects/{pid}/nodes/bulk-upload")
async def bulk_upload_nodes(
    pid: str,
    file: UploadFile = File(...),
    user: dict = Depends(require_role(ROLE_COORD)),
):
    """Carga masiva genérica de nodos desde un archivo .xlsx o .csv.

    Devuelve resumen: {created, updated, skipped, errors, total}.
    """
    await ensure_project_access(user, pid)
    proj = await db.projects.find_one({"id": pid})
    if not proj:
        raise HTTPException(404, "Proyecto no existe")
    try:
        raw = await file.read()
    except Exception as e:
        raise HTTPException(400, f"No se pudo leer el archivo: {e}")
    if not raw:
        raise HTTPException(400, "Archivo vacío")
    return await _process_nodes_bulk_upload(pid, raw, file.filename or "")


async def _process_nodes_bulk_upload(pid: str, raw: bytes, filename: str) -> dict:
    """Núcleo reutilizable de la carga masiva de nodos.

    Recibe el contenido binario y el nombre original del archivo y devuelve el
    resumen `{total_rows, created, updated, skipped, errors, ...}`. Es invocado
    por:
      - POST /projects/{pid}/nodes/bulk-upload  (endpoint dedicado)
      - POST /projects/{pid}/upload-file        (router genérico)
    """
    fname = (filename or "").lower()
    try:
        import pandas as pd  # noqa: WPS433
    except Exception as e:  # pragma: no cover
        raise HTTPException(500, f"pandas no disponible: {e}")

    try:
        if fname.endswith(".csv"):
            df = pd.read_csv(io.BytesIO(raw), dtype=object, keep_default_na=True)
        elif fname.endswith(".xlsx") or fname.endswith(".xls"):
            df = pd.read_excel(io.BytesIO(raw), dtype=object, engine="openpyxl")
        else:
            # Intento auto: primero xlsx, después csv
            try:
                df = pd.read_excel(io.BytesIO(raw), dtype=object, engine="openpyxl")
            except Exception:
                df = pd.read_csv(io.BytesIO(raw), dtype=object, keep_default_na=True)
    except Exception as e:
        raise HTTPException(400, f"No se pudo parsear el archivo: {e}")

    if df is None or df.empty:
        raise HTTPException(400, "El archivo no contiene filas")

    # Identificar columna de nombre
    cols = list(df.columns)
    norm_to_orig = {_normalize_col(str(c)): c for c in cols}

    name_col = None
    for cand in _NODE_NAME_CANDIDATES:
        if cand in norm_to_orig:
            name_col = norm_to_orig[cand]
            break
    if name_col is None and cols:
        name_col = cols[0]  # fallback: primera columna

    parent_col = None
    for cand in _NODE_PARENT_CANDIDATES:
        if cand in norm_to_orig:
            parent_col = norm_to_orig[cand]
            break

    if name_col is None:
        raise HTTPException(400, "No se pudo identificar la columna de nombre")

    # Cargar nodos existentes del proyecto en memoria (map por nombre-lower)
    existing_docs = await db.location_nodes.find({"project_id": pid}).to_list(length=10000)
    by_name_lower: dict = {}
    for n in existing_docs:
        key = (n.get("name") or "").strip().lower()
        if key:
            by_name_lower[key] = n

    # Calcular siguiente "order" para raíces nuevas
    existing_roots = [n for n in existing_docs if not n.get("parent_id")]
    next_order = max([n.get("order", 0) for n in existing_roots], default=-1) + 1

    summary = {
        "total_rows": int(len(df)),
        "created": 0,
        "updated": 0,
        "skipped": 0,
        "errors": [],
        "name_column": str(name_col),
        "parent_column": str(parent_col) if parent_col else None,
        "metadata_columns": [str(c) for c in cols if c != name_col and c != parent_col],
    }

    # Procesamos en 2 pasadas para resolver referencias de padre forward.
    rows = df.to_dict(orient="records")

    async def upsert_row(row: dict, second_pass: bool = False):
        nonlocal next_order
        raw_name = _coerce_cell(row.get(name_col))
        if raw_name is None or str(raw_name).strip() == "":
            summary["skipped"] += 1
            return
        name = str(raw_name).strip()
        # Resolver padre por nombre (si la columna existe)
        parent_doc = None
        if parent_col:
            raw_parent = _coerce_cell(row.get(parent_col))
            if raw_parent:
                pname = str(raw_parent).strip().lower()
                parent_doc = by_name_lower.get(pname)
                if not parent_doc and not second_pass:
                    # Diferimos: el padre puede aparecer más adelante.
                    return "defer"
        # Construir metadata con resto de columnas
        metadata: dict = {}
        for c in cols:
            if c == name_col or c == parent_col:
                continue
            val = _coerce_cell(row.get(c))
            if val is None:
                continue
            # Convertir tipos no-JSON-serializables
            try:
                import numpy as np  # noqa: WPS433
                if isinstance(val, (np.integer,)):
                    val = int(val)
                elif isinstance(val, (np.floating,)):
                    val = float(val)
            except Exception:
                pass
            if isinstance(val, (datetime,)):
                val = val.isoformat()
            metadata[str(c)] = val

        key = name.lower()
        existing = by_name_lower.get(key)
        if existing:
            # Update: refrescamos metadata y parent_id (si vino padre)
            upd: dict = {"metadata": metadata}
            if parent_doc:
                upd["parent_id"] = parent_doc["id"]
                upd["depth"] = int(parent_doc.get("depth", 0)) + 1
            await db.location_nodes.update_one({"id": existing["id"]}, {"$set": upd})
            existing["metadata"] = metadata
            if parent_doc:
                existing["parent_id"] = parent_doc["id"]
                existing["depth"] = upd["depth"]
            summary["updated"] += 1
        else:
            nid = str(uuid.uuid4())
            parent_id = parent_doc["id"] if parent_doc else None
            depth = (int(parent_doc.get("depth", 0)) + 1) if parent_doc else 0
            order_val = 0 if parent_doc else next_order
            if not parent_doc:
                next_order += 1
            doc = {
                "id": nid,
                "project_id": pid,
                "parent_id": parent_id,
                "name": name,
                "depth": depth,
                "order": order_val,
                "is_leaf": False,
                "measurement_type": None,
                "target_lat": None,
                "target_lon": None,
                "target_elev": None,
                "meta": None,
                "metadata": metadata,
                "created_at": datetime.now(timezone.utc),
            }
            # Si tiene padre que era hoja, ya no lo es
            if parent_doc and parent_doc.get("is_leaf"):
                await db.location_nodes.update_one(
                    {"id": parent_doc["id"]},
                    {"$set": {
                        "is_leaf": False, "measurement_type": None,
                        "target_lat": None, "target_lon": None, "target_elev": None,
                    }},
                )
                parent_doc["is_leaf"] = False
            await db.location_nodes.insert_one(doc)
            doc_clean = {k: v for k, v in doc.items() if k != "_id"}
            by_name_lower[key] = doc_clean
            summary["created"] += 1
        return None

    # Pasada 1
    deferred: list = []
    for idx, row in enumerate(rows):
        try:
            r = await upsert_row(row, second_pass=False)
            if r == "defer":
                deferred.append((idx, row))
        except Exception as e:
            summary["errors"].append({"row": idx + 2, "error": str(e)})

    # Pasada 2 (resuelve padres que se crearon después)
    for idx, row in deferred:
        try:
            await upsert_row(row, second_pass=True)
        except Exception as e:
            summary["errors"].append({"row": idx + 2, "error": str(e)})

    return summary


# === UPLOAD GENÉRICO DE ARCHIVOS DEL PROYECTO ===============================
UPLOADS_DIR = Path(os.environ.get("UPLOADS_DIR", "/app/backend/uploads"))
try:
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
except Exception as _exc:  # pragma: no cover
    log.warning("[uploads] no se pudo crear %s: %s", UPLOADS_DIR, _exc)

# Conjuntos de tipos para enrutar la lógica.
_NODES_EXTS = {".xlsx", ".xls", ".csv"}
_NODES_MIMES = {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "text/csv",
    "application/csv",
}
# PDF / Word / Excel (binarios que solo se guardan en disco).
_ALLOWED_DOC_MIMES = {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "text/csv",
}
_MAX_FILE_BYTES = 20 * 1024 * 1024  # 20 MB (límite acordado para subidas en campo)


def _safe_filename(name: str) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", (name or "archivo")).strip("._")
    return base[:120] or "archivo"


@api.post("/projects/{pid}/upload-file")
async def upload_project_file(
    pid: str,
    file: UploadFile = File(...),
    user: dict = Depends(require_role(ROLE_COORD, ROLE_JEFE)),
):
    """
    Router de archivos del proyecto. Acepta multipart/form-data.

    - Si el archivo es Excel/CSV de coordenadas (xlsx, xls, csv) → ejecuta el
      pipeline de carga masiva de nodos y devuelve el resumen.
    - Si es PDF/Word u otro documento permitido → lo guarda en `uploads/{pid}/`
      y lo añade a `project.reference_files`. Devuelve el registro creado.

    Limite por archivo: 25 MB. Solo Coordinador / Jefe de Proyecto.
    """
    await ensure_project_access(user, pid)
    proj = await db.projects.find_one({"id": pid})
    if not proj:
        raise HTTPException(404, "Proyecto no existe")

    try:
        raw = await file.read()
    except Exception as e:
        raise HTTPException(400, f"No se pudo leer el archivo: {e}")
    if not raw:
        raise HTTPException(400, "Archivo vacío")
    if len(raw) > _MAX_FILE_BYTES:
        raise HTTPException(
            413,
            f"Archivo demasiado grande ({len(raw)//1024//1024} MB). Máx {_MAX_FILE_BYTES//1024//1024} MB.",
        )

    orig = file.filename or "archivo"
    ext = (Path(orig).suffix or "").lower()
    ctype = (file.content_type or "").lower().split(";", 1)[0].strip()

    is_nodes = ext in _NODES_EXTS or ctype in _NODES_MIMES
    if is_nodes:
        try:
            summary = await _process_nodes_bulk_upload(pid, raw, orig)
        except HTTPException:
            raise
        except Exception as exc:
            log.exception("[upload-file] bulk_upload falló: %s", exc)
            raise HTTPException(400, f"No se pudo procesar el archivo de nodos: {exc}")
        return {
            "type": "nodes_bulk",
            "filename": orig,
            "mime_type": ctype or "application/octet-stream",
            "size": len(raw),
            "summary": summary,
        }

    # Documento (PDF/Word/etc.) → persistir en disco.
    if ctype and ctype not in _ALLOWED_DOC_MIMES:
        # No bloqueamos por extensión si el MIME es genérico, pero sí lo registramos.
        log.info("[upload-file] MIME no-listado pero aceptado: %s (%s)", ctype, orig)

    safe_name = _safe_filename(orig)
    file_id = uuid.uuid4().hex
    proj_dir = UPLOADS_DIR / pid
    try:
        proj_dir.mkdir(parents=True, exist_ok=True)
        on_disk = proj_dir / f"{file_id}__{safe_name}"
        on_disk.write_bytes(raw)
    except Exception as exc:
        log.exception("[upload-file] no se pudo escribir en disco: %s", exc)
        raise HTTPException(500, f"No se pudo guardar el archivo: {exc}")

    record = {
        "file_id": file_id,
        "name": Path(orig).stem or orig,
        "original_name": orig,
        "mime_type": ctype or "application/octet-stream",
        "size": len(raw),
        "url": f"/api/projects/{pid}/files/{file_id}",
        "path": str(on_disk),
        "uploaded_by": user.get("id"),
        "uploaded_by_name": user.get("name"),
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
    }

    await db.projects.update_one(
        {"id": pid},
        {"$push": {"reference_files": record}},
    )

    return {
        "type": "stored",
        "filename": orig,
        "mime_type": record["mime_type"],
        "size": record["size"],
        "file": record,
    }


@api.get("/projects/{pid}/files/{file_id}")
async def download_project_file(
    pid: str,
    file_id: str,
    user: dict = Depends(current_user),
):
    """Descarga un archivo previamente subido al proyecto.

    Requiere acceso al proyecto (rol/scope).
    """
    await ensure_project_access(user, pid)
    proj = await db.projects.find_one({"id": pid}, {"_id": 0, "reference_files": 1})
    if not proj:
        raise HTTPException(404, "Proyecto no existe")
    refs = (proj or {}).get("reference_files") or []
    rec = next((f for f in refs if (f or {}).get("file_id") == file_id), None)
    if not rec:
        raise HTTPException(404, "Archivo no encontrado")
    on_disk = Path(rec.get("path") or "")
    if not on_disk.exists():
        raise HTTPException(404, "Archivo no disponible en disco")
    return FileResponse(
        path=str(on_disk),
        media_type=rec.get("mime_type") or "application/octet-stream",
        filename=rec.get("original_name") or on_disk.name,
    )


@api.delete("/projects/{pid}/files/{file_id}")
async def delete_project_file(
    pid: str,
    file_id: str,
    user: dict = Depends(require_role(ROLE_COORD, ROLE_JEFE)),
):
    """Elimina un archivo adjunto del proyecto (registro + binario en disco)."""
    await ensure_project_access(user, pid)
    proj = await db.projects.find_one({"id": pid}, {"_id": 0, "reference_files": 1})
    if not proj:
        raise HTTPException(404, "Proyecto no existe")
    refs = (proj or {}).get("reference_files") or []
    rec = next((f for f in refs if (f or {}).get("file_id") == file_id), None)
    if not rec:
        raise HTTPException(404, "Archivo no encontrado")
    # Quitar de la BD primero (la verdad de origen).
    await db.projects.update_one(
        {"id": pid},
        {"$pull": {"reference_files": {"file_id": file_id}}},
    )
    # Best-effort: borrar binario.
    try:
        on_disk = Path(rec.get("path") or "")
        if on_disk.exists():
            on_disk.unlink()
    except Exception as exc:
        log.warning("[upload-file] no se pudo borrar binario: %s", exc)
    return {"ok": True, "file_id": file_id}


# === AREAS (por proyecto) ===================================================
@api.get("/projects/{pid}/areas")
async def list_areas(pid: str, user: dict = Depends(current_user)):
    await ensure_project_access(user, pid)
    items = await db.areas.find({"project_id": pid}).sort("name", 1).to_list(length=200)
    for it in items:
        it.pop("_id", None)
    return items


@api.post("/projects/{pid}/areas")
async def create_area(pid: str, body: AreaIn, user: dict = Depends(require_role(ROLE_COORD))):
    if body.project_id != pid:
        raise HTTPException(400, "project_id mismatch")
    await ensure_project_access(user, pid)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Nombre requerido")
    existing = await db.areas.find_one({"project_id": pid, "name": name})
    if existing:
        raise HTTPException(409, "Área ya existe en este proyecto")
    doc = {
        "id": str(uuid.uuid4()),
        "project_id": pid,
        "name": name,
        "color": body.color or "#1E40AF",
        "created_at": datetime.now(timezone.utc),
    }
    await db.areas.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api.delete("/areas/{aid}")
async def delete_area(aid: str, user: dict = Depends(require_role(ROLE_COORD))):
    a = await db.areas.find_one({"id": aid})
    if not a:
        raise HTTPException(404, "Área no existe")
    await db.areas.delete_one({"id": aid})
    return {"ok": True}


# === INVITATIONS ============================================================
@api.get("/projects/{pid}/invitations")
async def list_invites(pid: str, user: dict = Depends(require_role(ROLE_COORD))):
    await ensure_project_access(user, pid)
    items = await db.invitations.find({"project_id": pid}).sort("created_at", -1).to_list(length=500)
    for it in items:
        it.pop("_id", None)
    return items


@api.post("/projects/{pid}/invitations")
async def create_invite(pid: str, body: InvitationIn, user: dict = Depends(require_role(ROLE_COORD))):
    if body.project_id != pid:
        raise HTTPException(400, "project_id mismatch")
    project = await ensure_project_access(user, pid)
    email = body.email.lower()
    # Validaciones por rol (deben ejecutarse antes del auto-link para validar pertenencia al proyecto)
    if body.role == "sub_coordinador":
        if not body.scope_node_id:
            raise HTTPException(400, "Sub-coordinador requiere scope_node_id")
        node = await db.location_nodes.find_one({"id": body.scope_node_id, "project_id": pid})
        if not node:
            raise HTTPException(404, "scope_node_id inválido")
    elif body.role == "especialista":
        if not body.area_id:
            raise HTTPException(400, "Especialista requiere area_id")
        area = await db.areas.find_one({"id": body.area_id, "project_id": pid})
        if not area:
            raise HTTPException(404, "area_id inválido")
        if not body.scope_node_ids:
            raise HTTPException(400, "Especialista requiere al menos 1 scope_node_id")
        # Todos deben ser hojas del proyecto
        nodes = await db.location_nodes.find(
            {"id": {"$in": body.scope_node_ids}, "project_id": pid}
        ).to_list(length=1000)
        if len(nodes) != len(body.scope_node_ids):
            raise HTTPException(400, "scope_node_ids contiene IDs inválidos")
        for n in nodes:
            if not n.get("is_leaf"):
                raise HTTPException(400, f"Nodo '{n['name']}' no es hoja")
    # ====================================================================
    # REGLA GLOBAL: 1 USUARIO = 1 PROYECTO
    # --------------------------------------------------------------------
    # Un mismo correo NO puede ser invitado ni dado de alta en más de un
    # proyecto. Si ya existe como usuario en ANY proyecto, o si tiene una
    # invitación pendiente en OTRO proyecto, rechazamos con 400.
    # ====================================================================
    existing_user = await db.users.find_one({"email": email})
    if existing_user:
        raise HTTPException(400, "Este usuario ya está asignado a otro proyecto")
    pending_in_other = await db.invitations.find_one({
        "email": email,
        "status": "pending",
        "project_id": {"$ne": pid},
    })
    if pending_in_other:
        raise HTTPException(400, "Este usuario ya está asignado a otro proyecto")
    tok = secrets.token_urlsafe(24)
    doc = {
        "id": str(uuid.uuid4()),
        "token": tok,
        "project_id": pid,
        "project_name": project["name"],
        "email": email,
        "name": body.name.strip(),
        "role": body.role,
        "area_id": body.area_id,
        "puesto": (body.puesto or "").strip() or None,
        "scope_node_id": body.scope_node_id,
        "scope_node_ids": body.scope_node_ids or [],
        "status": "pending",
        "created_at": datetime.now(timezone.utc),
        "expires_at": datetime.now(timezone.utc) + timedelta(days=30),
    }
    await db.invitations.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api.delete("/invitations/{iid}")
async def revoke_invite(iid: str, user: dict = Depends(require_role(ROLE_COORD))):
    r = await db.invitations.update_one({"id": iid, "status": "pending"}, {"$set": {"status": "revoked"}})
    if r.matched_count == 0:
        raise HTTPException(404, "Invitación no pendiente")
    return {"ok": True}


@api.get("/invitations/by-token/{tok}")
async def invite_preview(tok: str):
    inv = await db.invitations.find_one({"token": tok})
    if not inv:
        raise HTTPException(404, "Invitación inválida")
    if inv["status"] != "pending":
        raise HTTPException(410, f"Invitación {inv['status']}")
    exp = inv["expires_at"]
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    if exp < datetime.now(timezone.utc):
        raise HTTPException(410, "Invitación expirada")
    inv.pop("_id", None)
    area_name = None
    if inv.get("area_id"):
        area = await db.areas.find_one({"id": inv["area_id"]})
        if area:
            area_name = area.get("name")
    return {
        "project_name": inv["project_name"],
        "email": inv["email"],
        "name": inv["name"],
        "role": inv["role"],
        "puesto": inv.get("puesto"),
        "area_name": area_name,
    }


@api.post("/invitations/accept", response_model=Token)
async def accept_invite(body: AcceptInviteIn):
    inv = await db.invitations.find_one({"token": body.token})
    if not inv:
        raise HTTPException(404, "Invitación inválida")
    if inv["status"] != "pending":
        raise HTTPException(410, f"Invitación {inv['status']}")
    exp = inv["expires_at"]
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    if exp < datetime.now(timezone.utc):
        raise HTTPException(410, "Invitación expirada")
    if len(body.password) < 6:
        raise HTTPException(400, "Password mínimo 6 caracteres")
    existing = await db.users.find_one({"email": inv["email"]})
    if existing:
        raise HTTPException(400, "Este usuario ya está asignado a otro proyecto")
    uid = str(uuid.uuid4())
    # Obtener nombre del área si aplica
    area_name = None
    if inv.get("area_id"):
        a = await db.areas.find_one({"id": inv["area_id"]})
        if a:
            area_name = a["name"]
    user_doc = {
        "id": uid,
        "email": inv["email"],
        "password": hash_pw(body.password),
        "name": inv["name"],
        "role": inv["role"],
        "area": area_name,
        "area_id": inv.get("area_id"),
        "puesto": inv.get("puesto"),
        "scope_node_id": inv.get("scope_node_id"),
        "scope_node_ids": inv.get("scope_node_ids") or [],
        "project_ids": [inv["project_id"]],
        "created_at": datetime.now(timezone.utc),
    }
    await db.users.insert_one(user_doc)
    await db.invitations.update_one(
        {"id": inv["id"]}, {"$set": {"status": "accepted", "accepted_at": datetime.now(timezone.utc), "accepted_user_id": uid}}
    )
    return {"token": make_token(uid), "user": user_to_out(user_doc)}


# === REPORTS ================================================================
def validate_measurement_value(mtype: str, value: dict):
    if mtype == "coord_latlon":
        lat, lon = value.get("lat"), value.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            raise HTTPException(400, "coord_latlon requiere lat y lon numéricos")
        # Nota: en obra civil usamos UTM (X/Y en cientos de miles o millones),
        # por lo que NO aplicamos restricción geográfica -90/90, -180/180.
    elif mtype == "cadenamiento":
        v = value.get("cadenamiento") or value.get("value")
        if not isinstance(v, str) or not re.match(r"^\d+\+\d{1,4}(\.\d+)?$", v):
            raise HTTPException(400, "cadenamiento formato '5+100' o '5+100.50'")
    elif mtype == "eje":
        v = value.get("eje") or value.get("value")
        if not isinstance(v, str) or not v.strip():
            raise HTTPException(400, "eje requiere texto")
    elif mtype == "nivel":
        v = value.get("nivel") if "nivel" in value else value.get("value")
        if not isinstance(v, (int, float)):
            raise HTTPException(400, "nivel requiere número decimal")
    else:
        raise HTTPException(400, f"measurement_type desconocido: {mtype}")


@api.post("/reports")
async def create_report(body: ReportIn, user: dict = Depends(current_user)):
    if user["role"] not in (ROLE_ESPECIALISTA, ROLE_COORD, ROLE_SUB, ROLE_JEFE):
        raise HTTPException(403, "Tu rol no puede capturar reportes")
    await ensure_project_access(user, body.project_id)
    node = await db.location_nodes.find_one({"id": body.node_id, "project_id": body.project_id})
    if not node:
        raise HTTPException(404, "Nodo no existe en este proyecto")
    if not node.get("is_leaf"):
        raise HTTPException(400, "Solo se puede capturar en nodos hoja")
    if user["role"] == ROLE_ESPECIALISTA:
        if body.node_id not in (user.get("scope_node_ids") or []):
            raise HTTPException(403, "Nodo no está en tu scope autorizado")
    # Sub-coordinador: scope GLOBAL (puede capturar en cualquier hoja del proyecto).
    # ====================================================================
    # FALLBACK DE COORDENADAS DESDE metadata DEL NODO (pre-validación)
    # --------------------------------------------------------------------
    # Si el nodo es coord_latlon y el cliente NO mandó lat/lon válidos,
    # intentamos inyectar X/Y desde node.metadata ANTES de validar para que
    # la captura no falle cuando el Coordinador ya cargó coords vía Excel.
    # El cliente conserva el control: si manda valores, esos se respetan.
    # ====================================================================
    pre_mv = dict(body.measurement_value or {})
    if node.get("measurement_type") == "coord_latlon":
        pre_lat = pre_mv.get("lat")
        pre_lon = pre_mv.get("lon")
        client_valid = (
            isinstance(pre_lat, (int, float)) and isinstance(pre_lon, (int, float))
            and not (pre_lat == 0 and pre_lon == 0)
        )
        if not client_valid:
            node_meta = node.get("metadata") or {}
            inh_x = None
            inh_y = None
            if isinstance(node_meta, dict):
                for k, v in node_meta.items():
                    if v is None or not isinstance(k, str):
                        continue
                    kn = k.strip().lower()
                    for src, dst in (("á","a"),("é","e"),("í","i"),("ó","o"),("ú","u")):
                        kn = kn.replace(src, dst)
                    if kn in {"x", "coordenada x", "coord x"} and inh_x is None:
                        try: inh_x = float(v)
                        except Exception: pass
                    elif kn in {"y", "coordenada y", "coord y"} and inh_y is None:
                        try: inh_y = float(v)
                        except Exception: pass
            if inh_x is not None and inh_y is not None:
                pre_mv["lat"] = inh_y
                pre_mv["lon"] = inh_x
                # marcamos source para que el cierre sepa que fue fallback
                pre_mv["coord_source"] = "node_metadata"
                body.measurement_value = pre_mv

    validate_measurement_value(node["measurement_type"], body.measurement_value)
    path_names = await node_path_names(body.node_id)
    area_name = None
    if body.area_id:
        a = await db.areas.find_one({"id": body.area_id, "project_id": body.project_id})
        if a:
            area_name = a["name"]
    elif user.get("area"):
        area_name = user["area"]
    # Persistimos lecturas P/U también dentro de measurement_value para que el
    # endpoint /history pueda devolverlas a la siguiente captura del nodo.
    mv = dict(body.measurement_value or {})
    if body.primera_lectura is not None:
        mv["primera_lectura"] = body.primera_lectura
    if body.ultima_lectura is not None:
        mv["ultima_lectura"] = body.ultima_lectura

    # ====================================================================
    # Trace de fuente de coordenadas (para auditoría).
    # Si pre-validación ya marcó coord_source=node_metadata, se mantiene.
    # En caso contrario, asumimos user_input.
    # ====================================================================
    if node.get("measurement_type") == "coord_latlon" and "coord_source" not in mv:
        mv["coord_source"] = "user_input"
    inherited_target = None
    if mv.get("coord_source") == "node_metadata":
        inherited_target = {"lat": mv.get("lat"), "lon": mv.get("lon"), "elev": None}

    # ====================================================================
    # Normalizar severidad (Informativo / Importante / Urgente).
    # Default = "informativo" (no escala a supervisores en exportaciones).
    # ====================================================================
    sev_raw = (body.severidad or "informativo").strip().lower()
    if sev_raw not in ("informativo", "importante", "urgente"):
        sev_raw = "informativo"

    # Lista de ids ancestrales (incluye el propio nodo) — para filtros y
    # vinculación de noticias a ancestros en la exportación.
    node_path_ids = list(node.get("path") or [])
    if body.node_id not in node_path_ids:
        node_path_ids.append(body.node_id)

    doc = {
        "id": str(uuid.uuid4()),
        "project_id": body.project_id,
        "node_id": body.node_id,
        "node_path_names": path_names,
        "node_path_ids": node_path_ids,
        "measurement_type": node["measurement_type"],
        "measurement_value": mv,
        "node_target": inherited_target if inherited_target is not None else (
            {
                "lat": node.get("target_lat"),
                "lon": node.get("target_lon"),
                "elev": node.get("target_elev"),
            } if node.get("measurement_type") == "coord_latlon" else None
        ),
        "area_id": body.area_id or user.get("area_id"),
        "area_name": area_name,
        "notes": (body.notes or "").strip() or None,
        "avance": (body.avance or "").strip() or None,
        "observaciones": (body.observaciones or "").strip() or None,
        "incidencias": (body.incidencias or "").strip() or None,
        "severidad": sev_raw,
        "contratista": (body.contratista or "").strip() or None,
        "personnel": body.personnel,
        "equipment": body.equipment,
        "images": body.images,
        "files": body.files,
        "primera_lectura": body.primera_lectura,
        "ultima_lectura": body.ultima_lectura,
        "unidad": (body.unidad or "m").strip() or "m",
        "captured_by": user["id"],
        "captured_by_name": user["name"],
        "created_at": datetime.now(timezone.utc),
    }
    await db.reports.insert_one(doc)
    doc.pop("_id", None)

    # ====================================================================
    # PUSH NOTIFICATION DISPATCH (background, fire-and-forget)
    # --------------------------------------------------------------------
    # Notifica a los supervisores del proyecto (Coordinador General y Jefe
    # de Proyecto) cuando se captura un nuevo reporte. Se ejecuta como
    # tarea en segundo plano con asyncio.create_task() para no bloquear
    # la respuesta al especialista.
    # ====================================================================
    try:
        project = await db.projects.find_one(
            {"id": body.project_id},
            {"_id": 0, "name": 1},
        )
        project_name = (project or {}).get("name") or "el proyecto"
        node_name = (path_names[-1] if path_names else None) or node.get("name") or "nodo"
        asyncio.create_task(
            _notify_supervisors_new_report(
                project_id=body.project_id,
                project_name=project_name,
                node_name=node_name,
                report_id=doc["id"],
                author_id=user["id"],
                author_name=user.get("name") or "Especialista",
            )
        )
    except Exception as exc:  # defensive: nunca rompemos el return del reporte.
        log.exception("[push] no se pudo agendar la notificación: %s", exc)

    return doc


async def _notify_supervisors_new_report(
    project_id: str,
    project_name: str,
    node_name: str,
    report_id: str,
    author_id: str,
    author_name: str,
) -> None:
    """
    Carga a los supervisores del proyecto (coordinador_general + jefe_proyecto)
    y dispara `send_push_notification` para cada uno. Se excluye al autor del
    reporte para que no se auto-notifique cuando él mismo lo captura.

    Esta función es defensiva: si un envío falla, se loguea y se continúa con
    el siguiente destinatario.
    """
    try:
        cursor = db.users.find(
            {
                "project_ids": project_id,
                "role": {"$in": [ROLE_COORD, ROLE_JEFE]},
            },
            {"_id": 0, "id": 1, "name": 1, "role": 1, "expo_push_tokens": 1},
        )
        recipients = [u async for u in cursor]
    except Exception as exc:
        log.exception("[push] no se pudo cargar destinatarios: %s", exc)
        return

    if not recipients:
        log.info(
            "[push] sin destinatarios (proyecto=%s, autor=%s)",
            project_id,
            author_name,
        )
        return

    title = f"Nuevo reporte en {project_name}"
    body_text = f"{author_name} registró un avance en {node_name}."
    payload = {
        "type": "new_report",
        "project_id": project_id,
        "report_id": report_id,
        "node_name": node_name,
    }

    for recipient in recipients:
        if recipient.get("id") == author_id:
            continue  # Skip self-notification.
        if not (recipient.get("expo_push_tokens") or []):
            continue  # Skip users without registered devices.
        try:
            result = await send_push_notification(
                user_id=recipient["id"],
                title=title,
                body=body_text,
                data=payload,
            )
            log.info(
                "[push] new_report → user=%s sent=%d ok=%s",
                recipient.get("name"),
                result.get("sent", 0),
                result.get("ok"),
            )
        except Exception as exc:
            log.exception(
                "[push] envío falló user=%s: %s",
                recipient.get("name"),
                exc,
            )


@api.get("/projects/{pid}/nodes/{nid}/history")
async def node_history(pid: str, nid: str, user: dict = Depends(current_user)):
    """Devuelve el último reporte del nodo para que el especialista pueda ver
    la lectura previa registrada (helper "Última lectura registrada en este
    nodo: [valor]"). Aplica el mismo RBAC que /reports.
    """
    await ensure_project_access(user, pid)
    node = await db.location_nodes.find_one({"id": nid, "project_id": pid})
    if not node:
        raise HTTPException(404, "Nodo no existe en este proyecto")
    if user["role"] == ROLE_ESPECIALISTA:
        if nid not in (user.get("scope_node_ids") or []):
            raise HTTPException(403, "Nodo no está en tu scope autorizado")
    # Sub-coordinador: acceso GLOBAL (sin restricción de scope).

    last = await db.reports.find_one(
        {"project_id": pid, "node_id": nid},
        sort=[("created_at", -1)],
    )
    if not last:
        return {
            "node_id": nid,
            "measurement_type": node.get("measurement_type"),
            "has_previous": False,
            "last_report": None,
        }
    last.pop("_id", None)
    mv = last.get("measurement_value") or {}
    return {
        "node_id": nid,
        "measurement_type": node.get("measurement_type"),
        "has_previous": True,
        "last_report": {
            "id": last.get("id"),
            "created_at": last.get("created_at"),
            "captured_by_name": last.get("captured_by_name"),
            "measurement_value": mv,
            "primera_lectura": mv.get("primera_lectura"),
            "ultima_lectura": mv.get("ultima_lectura"),
            "avance": last.get("avance"),
            "notes": last.get("notes"),
        },
    }


@api.get("/projects/{pid}/reports")
async def list_reports(pid: str, user: dict = Depends(current_user)):
    await ensure_project_access(user, pid)
    q: dict = {"project_id": pid}
    if user["role"] == ROLE_ESPECIALISTA:
        scope = user.get("scope_node_ids") or []
        q["node_id"] = {"$in": scope}
    # Sub-coordinador: acceso GLOBAL al listado de reportes (sin filtro de scope).
    items = await db.reports.find(q).sort("created_at", -1).to_list(length=2000)
    for it in items:
        it.pop("_id", None)
    return items


# ---- FEED endpoint (Specialist Dashboard) ---------------------------------
def _feed_range_start(rng: str) -> Optional[datetime]:
    """Devuelve el inicio del rango en UTC.

    today  → hoy 00:00 UTC
    week   → últimos 7 días (now - 7d)
    month  → últimos 30 días (now - 30d)
    all/None → None (sin filtro temporal)
    """
    now = datetime.now(timezone.utc)
    rng = (rng or "today").lower()
    if rng == "today":
        return now.replace(hour=0, minute=0, second=0, microsecond=0)
    if rng == "week":
        return now - timedelta(days=7)
    if rng == "month":
        return now - timedelta(days=30)
    return None


@api.get("/projects/{pid}/reports/feed")
async def reports_feed(
    pid: str,
    range: str = "today",
    limit: int = 50,
    user: dict = Depends(current_user),
):
    """Feed consolidado para Especialistas / Sub-Coordinadores.

    Devuelve estadísticas (total, mine, others) y la lista de reportes recientes
    livianos (solo primera imagen como thumbnail, conteo del resto).
    Aplica el mismo scope RBAC que list_reports.
    """
    await ensure_project_access(user, pid)
    q: dict = {"project_id": pid}
    if user["role"] == ROLE_ESPECIALISTA:
        scope = user.get("scope_node_ids") or []
        q["node_id"] = {"$in": scope}
    # Sub-coordinador: feed GLOBAL del proyecto (sin restricción de scope).

    start = _feed_range_start(range)
    if start is not None:
        q["created_at"] = {"$gte": start}

    # Conteos agregados por captured_by (con un solo round trip).
    pipeline = [
        {"$match": q},
        {"$group": {"_id": "$captured_by", "count": {"$sum": 1}}},
    ]
    groups = await db.reports.aggregate(pipeline).to_list(length=10000)
    total = sum(int(g.get("count", 0)) for g in groups)
    mine = sum(int(g.get("count", 0)) for g in groups if g.get("_id") == user["id"])
    others = total - mine

    # Lista de items livianos (orden desc, limit).
    safe_limit = max(1, min(int(limit or 50), 200))
    cursor = db.reports.find(q).sort("created_at", -1).limit(safe_limit)
    raw_items = await cursor.to_list(length=safe_limit)

    # Mapa de áreas (para color y nombre real).
    area_ids = {it.get("area_id") for it in raw_items if it.get("area_id")}
    areas_by_id: dict = {}
    if area_ids:
        async for a in db.areas.find({"id": {"$in": list(area_ids)}}):
            areas_by_id[a["id"]] = {"name": a.get("name"), "color": a.get("color")}

    items_out = []
    for it in raw_items:
        imgs = it.get("images") or []
        area_id = it.get("area_id")
        area_info = areas_by_id.get(area_id) if area_id else None
        items_out.append({
            "id": it["id"],
            "project_id": it["project_id"],
            "node_id": it["node_id"],
            "node_path_names": it.get("node_path_names") or [],
            "measurement_type": it.get("measurement_type"),
            "measurement_value": it.get("measurement_value") or {},
            "area_id": area_id,
            "area_name": (area_info or {}).get("name") or it.get("area_name"),
            "area_color": (area_info or {}).get("color"),
            "avance": it.get("avance"),
            "contratista": it.get("contratista"),
            "personnel": it.get("personnel") or [],
            "equipment": it.get("equipment") or [],
            "captured_by": it.get("captured_by"),
            "captured_by_name": it.get("captured_by_name"),
            "notes": it.get("notes"),
            "observaciones": it.get("observaciones"),
            "is_mine": it.get("captured_by") == user["id"],
            "images_count": len(imgs),
            "thumbnail_base64": imgs[0] if imgs else None,
            "created_at": it.get("created_at"),
        })

    return {
        "range": range,
        "stats": {"total": total, "mine": mine, "others": others},
        "reports": items_out,
    }


@api.get("/reports/{rid}")
async def get_report(rid: str, user: dict = Depends(current_user)):
    r = await db.reports.find_one({"id": rid})
    if not r:
        raise HTTPException(404, "Reporte no existe")
    await ensure_project_access(user, r["project_id"])
    # Scope check
    if user["role"] == ROLE_ESPECIALISTA:
        if r["node_id"] not in (user.get("scope_node_ids") or []):
            raise HTTPException(403, "Sin acceso a este reporte")
    # Sub-coordinador: acceso GLOBAL (sin filtro de scope).
    r.pop("_id", None)
    return r


# ---------------------------------------------------------------------------
# COLLAGE 2x2 (Fallback nativo para compartir en WhatsApp / mensajeros)
# ---------------------------------------------------------------------------
@api.get("/reports/{rid}/collage.jpg")
async def get_report_collage(rid: str, user: dict = Depends(current_user)):
    """Devuelve un JPEG con un collage 2x2 de hasta 4 fotos del reporte.
    Diseñado como fallback de compartir nativo: una sola imagen unificada
    incluye todo el material fotográfico clave del reporte.
    """
    r = await db.reports.find_one({"id": rid})
    if not r:
        raise HTTPException(404, "Reporte no existe")
    await ensure_project_access(user, r["project_id"])
    if user["role"] == ROLE_ESPECIALISTA:
        if r["node_id"] not in (user.get("scope_node_ids") or []):
            raise HTTPException(403, "Sin acceso a este reporte")
    imgs = (r.get("images") or [])[:4]
    if not imgs:
        raise HTTPException(404, "El reporte no tiene fotografías")

    from PIL import Image, ImageDraw, ImageFont  # noqa: WPS433

    # Lienzo final 1600x1600 (cuadrado, compatible con previews de WhatsApp).
    CANVAS = 1600
    GAP = 16
    CELL = (CANVAS - 3 * GAP) // 2  # 784 px por celda
    canvas = Image.new("RGB", (CANVAS, CANVAS), (245, 246, 250))

    # Cargar y normalizar cada imagen como un cuadrado CELL x CELL (cover).
    cells = []
    for b64 in imgs:
        try:
            raw = base64.b64decode(_strip_b64_prefix(b64))
            im = Image.open(io.BytesIO(raw)).convert("RGB")
            # Cover crop: escalar y recortar al centro
            iw, ih = im.size
            ratio = max(CELL / iw, CELL / ih)
            new_w, new_h = int(iw * ratio), int(ih * ratio)
            im = im.resize((new_w, new_h), Image.LANCZOS)
            left = (new_w - CELL) // 2
            top = (new_h - CELL) // 2
            im = im.crop((left, top, left + CELL, top + CELL))
            cells.append(im)
        except Exception:
            placeholder = Image.new("RGB", (CELL, CELL), (220, 220, 220))
            cells.append(placeholder)

    positions = [
        (GAP, GAP),
        (GAP * 2 + CELL, GAP),
        (GAP, GAP * 2 + CELL),
        (GAP * 2 + CELL, GAP * 2 + CELL),
    ]
    for i, cell in enumerate(cells):
        if i >= 4:
            break
        canvas.paste(cell, positions[i])

    # Marca SynCo discreta en la esquina inferior derecha
    try:
        draw = ImageDraw.Draw(canvas)
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 22)
        except Exception:
            font = ImageFont.load_default()
        stamp = f"SynCo · {len(cells)} foto{'s' if len(cells) != 1 else ''}"
        bbox = draw.textbbox((0, 0), stamp, font=font)
        w = bbox[2] - bbox[0]
        h = bbox[3] - bbox[1]
        pad = 10
        x0 = CANVAS - w - 2 * pad - GAP
        y0 = CANVAS - h - 2 * pad - GAP
        draw.rectangle([x0, y0, x0 + w + 2 * pad, y0 + h + 2 * pad],
                       fill=(15, 23, 42))
        draw.text((x0 + pad, y0 + pad), stamp, fill=(255, 255, 255), font=font)
    except Exception:
        pass

    buf = io.BytesIO()
    canvas.save(buf, format="JPEG", quality=88, optimize=True)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="image/jpeg",
        headers={"Content-Disposition": f'inline; filename="collage_{rid[:8]}.jpg"'},
    )




@api.delete("/reports/{rid}")
async def delete_report(rid: str, user: dict = Depends(current_user)):
    r = await db.reports.find_one({"id": rid})
    if not r:
        raise HTTPException(404, "Reporte no existe")
    if user["role"] != ROLE_COORD and r["captured_by"] != user["id"]:
        raise HTTPException(403, "Solo el autor o un Coordinador General puede borrar")
    await db.reports.delete_one({"id": rid})
    return {"ok": True}


# === USERS (admin) ==========================================================
@api.get("/projects/{pid}/users")
async def list_project_users(pid: str, user: dict = Depends(current_user)):
    """Lista usuarios miembros del proyecto. Cualquier miembro puede consultarla
    (usado para el selector de Mensajes Directos).

    Regla asimétrica: los Especialistas NO ven a los Coordinadores Generales en
    el directorio (no pueden iniciar chats con ellos).
    """
    await ensure_project_access(user, pid)
    # Incluye también a los Coord Generales y Jefes de Proyecto (que tienen
    # acceso global y pueden no estar en project_ids del documento).
    items = await db.users.find(
        {"$or": [
            {"project_ids": pid},
            {"role": {"$in": [ROLE_COORD, ROLE_JEFE]}},
        ]}
    ).to_list(length=1000)
    if user.get("role") == ROLE_ESPECIALISTA:
        items = [u for u in items if u.get("role") != ROLE_COORD]
    return [user_to_out(u) for u in items]


@api.get("/projects/{pid}/members")
async def list_project_members(pid: str, user: dict = Depends(current_user)):
    """Alias semántico de /users — lista miembros del proyecto."""
    await ensure_project_access(user, pid)
    items = await db.users.find(
        {"$or": [
            {"project_ids": pid},
            {"role": {"$in": [ROLE_COORD, ROLE_JEFE]}},
        ]}
    ).to_list(length=1000)
    if user.get("role") == ROLE_ESPECIALISTA:
        items = [u for u in items if u.get("role") != ROLE_COORD]
    return [user_to_out(u) for u in items]


# === ANNOUNCEMENTS (Noticias) ==============================================
class AnnouncementIn(BaseModel):
    title: str
    body: str
    pinned: bool = False
    jerarquia: Optional[str] = None  # 'urgente' | 'importante' | 'informativo' | None
    severidad: Optional[str] = None  # alias front-end de jerarquia
    audiencia: Optional[str] = None  # 'general' o area_id
    node_id: Optional[str] = None    # nodo al que se vincula la noticia (cualquier nivel)


class AnnouncementPatch(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    pinned: Optional[bool] = None
    jerarquia: Optional[str] = None
    severidad: Optional[str] = None
    audiencia: Optional[str] = None
    node_id: Optional[str] = None  # "" o null para desvincular


def _announcement_out(doc: dict) -> dict:
    doc.pop("_id", None)
    return doc


@api.get("/projects/{pid}/announcements")
async def list_announcements(pid: str, user: dict = Depends(current_user)):
    """Lista noticias del proyecto. Cualquier miembro del proyecto puede leer.

    Orden: pinned primero, luego más recientes primero.
    """
    await ensure_project_access(user, pid)
    cursor = db.announcements.find({"project_id": pid}).sort([("pinned", -1), ("created_at", -1)])
    items = await cursor.to_list(length=500)
    return [_announcement_out(it) for it in items]


@api.post("/projects/{pid}/announcements")
async def create_announcement(
    pid: str,
    body: AnnouncementIn,
    user: dict = Depends(current_user),
):
    """Cualquier miembro del proyecto puede publicar una noticia."""
    await ensure_project_access(user, pid)
    title = (body.title or "").strip()
    text = (body.body or "").strip()
    if not title:
        raise HTTPException(400, "Título requerido")
    if not text:
        raise HTTPException(400, "Cuerpo requerido")
    if len(title) > 140:
        raise HTTPException(400, "Título máximo 140 caracteres")
    if len(text) > 4000:
        raise HTTPException(400, "Cuerpo máximo 4000 caracteres")
    # Normaliza severidad/jerarquía (acepta ambos nombres).
    sev_raw = (body.severidad or body.jerarquia or "").strip().lower() or None
    if sev_raw and sev_raw not in ("urgente", "importante", "informativo"):
        raise HTTPException(400, "Severidad inválida")
    jerarquia = sev_raw
    # Audiencia: "general" (proyecto completo) o area_id
    audiencia = (body.audiencia or "").strip() or "general"
    if audiencia != "general":
        area = await db.areas.find_one({"id": audiencia, "project_id": pid})
        if not area:
            raise HTTPException(400, "Audiencia (área) inválida")
    # Vínculo opcional a nodo (cualquier nivel). Calculamos node_path_ids para
    # que el filtro por ancestros en la exportación sea O(1) en lectura.
    node_id = (body.node_id or "").strip() or None
    node_path_ids: list[str] = []
    node_name: Optional[str] = None
    if node_id:
        node = await db.location_nodes.find_one({"id": node_id, "project_id": pid})
        if not node:
            raise HTTPException(400, "Nodo no existe en este proyecto")
        node_path_ids = list(node.get("path") or [])
        if node_id not in node_path_ids:
            node_path_ids.append(node_id)
        node_name = node.get("name")
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "project_id": pid,
        "title": title,
        "body": text,
        "pinned": bool(body.pinned),
        "jerarquia": jerarquia,
        "audiencia": audiencia,
        "node_id": node_id,
        "node_path_ids": node_path_ids,
        "node_name": node_name,
        "author_id": user["id"],
        "author_name": user["name"],
        "author_role": user["role"],
        "created_at": now,
        "updated_at": now,
        "intranet": False,
    }
    await db.announcements.insert_one(doc)
    return _announcement_out(doc)


@api.patch("/announcements/{aid}")
async def update_announcement(
    aid: str,
    body: AnnouncementPatch,
    user: dict = Depends(current_user),
):
    """Editable por el autor o por cualquier Coordinador General."""
    a = await db.announcements.find_one({"id": aid})
    if not a:
        raise HTTPException(404, "Noticia no existe")
    await ensure_project_access(user, a["project_id"])
    is_author = a.get("author_id") == user["id"]
    is_coord = user["role"] == ROLE_COORD
    if not (is_author or is_coord):
        raise HTTPException(403, "Sólo el autor o un Coordinador puede editar")
    update: dict = {}
    if body.title is not None:
        t = body.title.strip()
        if not t:
            raise HTTPException(400, "Título no puede estar vacío")
        if len(t) > 140:
            raise HTTPException(400, "Título máximo 140 caracteres")
        update["title"] = t
    if body.body is not None:
        b = body.body.strip()
        if not b:
            raise HTTPException(400, "Cuerpo no puede estar vacío")
        if len(b) > 4000:
            raise HTTPException(400, "Cuerpo máximo 4000 caracteres")
        update["body"] = b
    if body.pinned is not None:
        # Sólo Coordinador puede fijar/desfijar (afecta visibilidad global).
        if not is_coord:
            raise HTTPException(403, "Sólo el Coordinador puede fijar noticias")
        update["pinned"] = bool(body.pinned)
    if body.jerarquia is not None or body.severidad is not None:
        j_raw = body.severidad if body.severidad is not None else body.jerarquia
        j = (j_raw or "").strip().lower()
        if j == "":
            update["jerarquia"] = None
        elif j in ("urgente", "importante", "informativo"):
            update["jerarquia"] = j
        else:
            raise HTTPException(400, "Severidad inválida")
    if body.audiencia is not None:
        aud = (body.audiencia or "").strip() or "general"
        if aud != "general":
            area = await db.areas.find_one({"id": aud, "project_id": a["project_id"]})
            if not area:
                raise HTTPException(400, "Audiencia (área) inválida")
        update["audiencia"] = aud
    if body.node_id is not None:
        nid = (body.node_id or "").strip()
        if not nid:
            update["node_id"] = None
            update["node_path_ids"] = []
            update["node_name"] = None
        else:
            node = await db.location_nodes.find_one({"id": nid, "project_id": a["project_id"]})
            if not node:
                raise HTTPException(400, "Nodo no existe en este proyecto")
            path_ids = list(node.get("path") or [])
            if nid not in path_ids:
                path_ids.append(nid)
            update["node_id"] = nid
            update["node_path_ids"] = path_ids
            update["node_name"] = node.get("name")
    if not update:
        return _announcement_out(a)
    update["updated_at"] = datetime.now(timezone.utc)
    await db.announcements.update_one({"id": aid}, {"$set": update})
    a = await db.announcements.find_one({"id": aid})
    return _announcement_out(a)


@api.delete("/announcements/{aid}")
async def delete_announcement(aid: str, user: dict = Depends(current_user)):
    """Eliminable por el autor o por cualquier Coordinador General."""
    a = await db.announcements.find_one({"id": aid})
    if not a:
        raise HTTPException(404, "Noticia no existe")
    await ensure_project_access(user, a["project_id"])
    is_author = a.get("author_id") == user["id"]
    is_coord = user["role"] == ROLE_COORD
    if not (is_author or is_coord):
        raise HTTPException(403, "Sólo el autor o un Coordinador puede eliminar")
    await db.announcements.delete_one({"id": aid})
    return {"ok": True}


# === CHANNELS + MESSAGES (Chat con canales: General / Áreas / Directos) =====
class MessageIn(BaseModel):
    text: str


def _message_out(doc: dict) -> dict:
    doc.pop("_id", None)
    return doc


def _channel_out(doc: dict) -> dict:
    doc.pop("_id", None)
    return doc


# Tipos de canal soportados
CHANNEL_TYPES = ("general", "area", "direct")


async def _ensure_default_channels(pid: str) -> None:
    """Crea (idempotentemente) el canal General y un canal por cada área del proyecto."""
    proj = await db.projects.find_one({"id": pid})
    if not proj:
        return
    # General
    g = await db.channels.find_one({"project_id": pid, "type": "general"})
    now = datetime.now(timezone.utc)
    if not g:
        await db.channels.insert_one({
            "id": str(uuid.uuid4()),
            "project_id": pid,
            "type": "general",
            "name": "General",
            "area_id": None,
            "color": None,
            "member_ids": None,
            "created_at": now,
        })
    # Per-area
    areas = await db.areas.find({"project_id": pid}).to_list(length=200)
    for area in areas:
        existing = await db.channels.find_one({
            "project_id": pid, "type": "area", "area_id": area["id"],
        })
        if not existing:
            await db.channels.insert_one({
                "id": str(uuid.uuid4()),
                "project_id": pid,
                "type": "area",
                "name": area["name"],
                "area_id": area["id"],
                "color": area.get("color"),
                "member_ids": None,
                "created_at": now,
            })
        else:
            # Sincroniza nombre/color con el área (por si Coord la renombró)
            patch = {}
            if existing.get("name") != area["name"]:
                patch["name"] = area["name"]
            if existing.get("color") != area.get("color"):
                patch["color"] = area.get("color")
            if patch:
                await db.channels.update_one({"id": existing["id"]}, {"$set": patch})


def _can_access_channel(user: dict, ch: dict) -> bool:
    pid = ch["project_id"]
    project_ids = user.get("project_ids") or []
    # ===== Roles gerenciales con acceso TRANSVERSAL al proyecto =====
    # Coordinador General y Jefe de Proyecto tienen acceso GLOBAL a todos los
    # proyectos (no dependen de project_ids). Sub-coordinador requiere
    # pertenencia explícita al proyecto.
    if user["role"] == ROLE_COORD or user["role"] == ROLE_JEFE:
        if ch["type"] == "direct":
            return user["id"] in (ch.get("member_ids") or [])
        return True
    if user["role"] == ROLE_SUB:
        if pid not in project_ids:
            return False
        if ch["type"] == "direct":
            return user["id"] in (ch.get("member_ids") or [])
        return True
    # ===== Especialistas =====
    if pid not in project_ids:
        return False
    if ch["type"] == "general":
        return True
    if ch["type"] == "area":
        # Especialistas con area_id que coincide.
        return user.get("area_id") and user.get("area_id") == ch.get("area_id")
    if ch["type"] == "direct":
        return user["id"] in (ch.get("member_ids") or [])
    return False


def _direct_peer_role(user_id: str, ch: dict, peer_role_cache: dict) -> Optional[str]:
    """Helper sync — devuelve el rol del 'otro' miembro de un canal directo,
    si ya está cacheado. Pensado para usarse dentro de funciones async donde
    el caller hace la carga del peer."""
    other_id = next((mid for mid in (ch.get("member_ids") or []) if mid != user_id), None)
    return peer_role_cache.get(other_id) if other_id else None


async def _check_direct_send_rule(sender: dict, ch: dict) -> None:
    """Aplica la regla asimétrica de mensajería del Coordinador General:
      - Coord General puede ENVIAR a cualquier rol.
      - Coord General sólo puede RECIBIR de Jefe de Proyecto y Sub-coordinador.
      - Por tanto, un Especialista NO puede enviar mensajes a un Coord General
        en un canal directo.
    Lanza HTTPException(403) si el envío es inválido. Sólo aplica a canales 'direct'.
    """
    if ch.get("type") != "direct":
        return
    if sender.get("role") != ROLE_ESPECIALISTA:
        return
    other_id = next(
        (mid for mid in (ch.get("member_ids") or []) if mid != sender["id"]),
        None,
    )
    if not other_id:
        return
    other = await db.users.find_one({"id": other_id}, {"role": 1})
    if other and other.get("role") == ROLE_COORD:
        raise HTTPException(
            403,
            "Los especialistas no pueden enviar mensajes al Coordinador General. "
            "Contacta a tu Jefe de Proyecto o Sub-coordinador.",
        )


async def _general_channel_id(pid: str) -> str:
    await _ensure_default_channels(pid)
    g = await db.channels.find_one({"project_id": pid, "type": "general"})
    return g["id"] if g else ""


@api.get("/projects/{pid}/channels")
async def list_channels(pid: str, user: dict = Depends(current_user)):
    """Lista los canales accesibles del proyecto para el usuario actual.
    Crea automáticamente los canales por defecto (General + uno por área) si faltan.
    Cada canal trae su último mensaje (preview) para la lista estilo Slack/WhatsApp."""
    await ensure_project_access(user, pid)
    await _ensure_default_channels(pid)
    raw = await db.channels.find({"project_id": pid}).to_list(length=500)
    out: list = []
    for ch in raw:
        if not _can_access_channel(user, ch):
            continue
        # Para directos: nombre dinámico = nombre del otro usuario
        display_name = ch.get("name") or ""
        peer = None
        if ch["type"] == "direct":
            other_id = next(
                (mid for mid in (ch.get("member_ids") or []) if mid != user["id"]),
                None,
            )
            if other_id:
                other = await db.users.find_one({"id": other_id})
                if other:
                    display_name = other.get("name") or display_name
                    peer = {
                        "id": other.get("id"),
                        "name": other.get("name"),
                        "role": other.get("role"),
                    }
        # Último mensaje
        last_doc = await db.messages.find({"channel_id": ch["id"]}).sort("created_at", -1).limit(1).to_list(length=1)
        last_msg = None
        if last_doc:
            lm = last_doc[0]
            last_msg = {
                "id": lm["id"],
                "text": (lm.get("text") or "")[:140],
                "user_id": lm.get("user_id"),
                "user_name": lm.get("user_name"),
                "created_at": lm.get("created_at"),
            }
        out.append({
            "id": ch["id"],
            "project_id": ch["project_id"],
            "type": ch["type"],
            "name": display_name,
            "area_id": ch.get("area_id"),
            "color": ch.get("color"),
            "member_ids": ch.get("member_ids"),
            "peer": peer,
            "last_message": last_msg,
            "created_at": ch.get("created_at"),
        })
    # Orden: general primero, luego áreas, luego directos por last_message desc
    type_order = {"general": 0, "area": 1, "direct": 2}

    def _sort_key(c):
        t = type_order.get(c["type"], 9)
        last_dt = (c.get("last_message") or {}).get("created_at")
        # Más reciente primero dentro del mismo grupo
        ts = last_dt.timestamp() if isinstance(last_dt, datetime) else 0
        return (t, -ts, (c.get("name") or "").lower())

    out.sort(key=_sort_key)
    return out


class DirectChannelIn(BaseModel):
    target_user_id: str


@api.post("/projects/{pid}/channels/direct")
async def create_direct_channel(pid: str, body: DirectChannelIn, user: dict = Depends(current_user)):
    """Crea (o devuelve si ya existe) un canal directo 1-a-1 entre el usuario actual y target_user_id."""
    await ensure_project_access(user, pid)
    if body.target_user_id == user["id"]:
        raise HTTPException(400, "No puedes iniciar un chat contigo mismo")
    target = await db.users.find_one({"id": body.target_user_id})
    if not target:
        raise HTTPException(404, "Usuario no existe")
    # Coord General y Jefe de Proyecto tienen acceso global a todos los proyectos,
    # por lo que su pertenencia se asume sin necesidad de project_ids.
    if target.get("role") not in (ROLE_COORD, ROLE_JEFE):
        if pid not in (target.get("project_ids") or []):
            raise HTTPException(404, "Ese usuario no pertenece al proyecto")
    # Regla asimétrica: un Especialista NO puede iniciar un chat con un Coordinador
    # General. El Coord General sí puede iniciar chats con cualquiera.
    if user.get("role") == ROLE_ESPECIALISTA and target.get("role") == ROLE_COORD:
        raise HTTPException(
            403,
            "Los especialistas no pueden iniciar chats con la Coordinación General. "
            "Contacta a tu Jefe de Proyecto o Sub-coordinador.",
        )
    members = sorted([user["id"], body.target_user_id])
    existing = await db.channels.find_one({
        "project_id": pid, "type": "direct", "member_ids": members,
    })
    if existing:
        existing.pop("_id", None)
        # Devuelve con nombre del peer
        existing["name"] = target.get("name") or "DM"
        existing["peer"] = {
            "id": target.get("id"), "name": target.get("name"), "role": target.get("role"),
        }
        return existing
    doc = {
        "id": str(uuid.uuid4()),
        "project_id": pid,
        "type": "direct",
        "name": "DM",  # se reemplaza por el nombre del peer en la respuesta
        "area_id": None,
        "color": None,
        "member_ids": members,
        "created_at": datetime.now(timezone.utc),
    }
    await db.channels.insert_one(doc)
    doc.pop("_id", None)
    doc["name"] = target.get("name") or "DM"
    doc["peer"] = {
        "id": target.get("id"), "name": target.get("name"), "role": target.get("role"),
    }
    return doc


@api.get("/channels/{cid}")
async def get_channel(cid: str, user: dict = Depends(current_user)):
    ch = await db.channels.find_one({"id": cid})
    if not ch:
        raise HTTPException(404, "Canal no existe")
    if not _can_access_channel(user, ch):
        raise HTTPException(403, "Sin acceso a este canal")
    ch.pop("_id", None)
    if ch["type"] == "direct":
        other_id = next((mid for mid in (ch.get("member_ids") or []) if mid != user["id"]), None)
        if other_id:
            other = await db.users.find_one({"id": other_id})
            if other:
                ch["name"] = other.get("name") or ch.get("name")
                ch["peer"] = {
                    "id": other.get("id"), "name": other.get("name"), "role": other.get("role"),
                }
    return ch


@api.get("/channels/{cid}/messages")
async def list_channel_messages(
    cid: str,
    since: Optional[str] = None,
    before: Optional[str] = None,
    limit: int = 100,
    user: dict = Depends(current_user),
):
    ch = await db.channels.find_one({"id": cid})
    if not ch:
        raise HTTPException(404, "Canal no existe")
    if not _can_access_channel(user, ch):
        raise HTTPException(403, "Sin acceso a este canal")
    q: dict = {"channel_id": cid}
    if since:
        try:
            ts = datetime.fromisoformat(since.replace("Z", "+00:00"))
            q["created_at"] = {"$gt": ts}
        except Exception:
            pass
    if before:
        try:
            ts = datetime.fromisoformat(before.replace("Z", "+00:00"))
            q.setdefault("created_at", {})["$lt"] = ts
        except Exception:
            pass
    safe_limit = max(1, min(int(limit or 100), 200))
    cursor = db.messages.find(q).sort("created_at", -1).limit(safe_limit)
    raw = await cursor.to_list(length=safe_limit)
    raw.reverse()
    return [_message_out(it) for it in raw]


@api.post("/channels/{cid}/messages")
async def post_channel_message(cid: str, body: MessageIn, user: dict = Depends(current_user)):
    ch = await db.channels.find_one({"id": cid})
    if not ch:
        raise HTTPException(404, "Canal no existe")
    if not _can_access_channel(user, ch):
        raise HTTPException(403, "Sin acceso a este canal")
    # Regla asimétrica del Coordinador General (sólo aplica en directos).
    await _check_direct_send_rule(user, ch)
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "Mensaje vacío")
    if len(text) > 2000:
        raise HTTPException(400, "Mensaje máximo 2000 caracteres")
    doc = {
        "id": str(uuid.uuid4()),
        "channel_id": cid,
        "project_id": ch["project_id"],
        "user_id": user["id"],
        "user_name": user["name"],
        "user_role": user["role"],
        "user_area": user.get("area"),
        "text": text,
        "created_at": datetime.now(timezone.utc),
    }
    await db.messages.insert_one(doc)
    return _message_out(doc)


# ---- Endpoints LEGACY: redirigen al canal General para mantener compatibilidad
@api.get("/projects/{pid}/messages")
async def list_messages_legacy(
    pid: str,
    since: Optional[str] = None,
    before: Optional[str] = None,
    limit: int = 100,
    user: dict = Depends(current_user),
):
    """Compat: lista mensajes del canal General del proyecto."""
    await ensure_project_access(user, pid)
    cid = await _general_channel_id(pid)
    if not cid:
        return []
    return await list_channel_messages(cid, since=since, before=before, limit=limit, user=user)


@api.post("/projects/{pid}/messages")
async def create_message_legacy(
    pid: str,
    body: MessageIn,
    user: dict = Depends(current_user),
):
    """Compat: publica en el canal General del proyecto."""
    await ensure_project_access(user, pid)
    cid = await _general_channel_id(pid)
    if not cid:
        raise HTTPException(500, "No se pudo asegurar el canal general")
    return await post_channel_message(cid, body, user)


@api.delete("/messages/{mid}")
async def delete_message(mid: str, user: dict = Depends(current_user)):
    """El autor o cualquier Coordinador General del proyecto puede eliminar."""
    m = await db.messages.find_one({"id": mid})
    if not m:
        raise HTTPException(404, "Mensaje no existe")
    is_author = m["user_id"] == user["id"]
    is_coord = user["role"] == ROLE_COORD and m["project_id"] in (user.get("project_ids") or [])
    if not (is_author or is_coord):
        raise HTTPException(403, "Sin permiso para eliminar este mensaje")
    await db.messages.delete_one({"id": mid})
    return {"ok": True}


# === MENSAJES NO LEÍDOS (badges en picker de proyectos) ====================
@api.post("/projects/{pid}/messages/seen")
async def mark_project_messages_seen(pid: str, user: dict = Depends(current_user)):
    """Marca como leídos todos los mensajes del proyecto para el usuario actual.
    Persiste `last_read_at = now()` en la colección `channel_reads`.
    """
    await ensure_project_access(user, pid)
    now = datetime.now(timezone.utc)
    await db.channel_reads.update_one(
        {"user_id": user["id"], "project_id": pid},
        {"$set": {"last_read_at": now}},
        upsert=True,
    )
    return {"ok": True, "last_read_at": now.isoformat()}


@api.get("/messages/unread_counts")
async def messages_unread_counts(user: dict = Depends(current_user)):
    """Devuelve `{project_id: count}` con el total de mensajes no leídos por
    proyecto para el usuario actual. Sólo cuenta mensajes ajenos (no enviados
    por el propio usuario).

    Optimizado para tableros: una sola pasada por todos los proyectos del
    usuario y un agregado en MongoDB por proyecto.
    """
    role = user.get("role")
    # 1) Determinar la lista de proyectos accesibles para el usuario.
    if role in (ROLE_COORD, ROLE_JEFE):
        projects = await db.projects.find({}, {"id": 1}).to_list(length=1000)
        pids = [p["id"] for p in projects]
    else:
        pids = list(user.get("project_ids") or [])
    if not pids:
        return {}
    # 2) Cargar last_read_at por proyecto en bloque.
    reads_cur = db.channel_reads.find(
        {"user_id": user["id"], "project_id": {"$in": pids}},
        {"project_id": 1, "last_read_at": 1, "_id": 0},
    )
    reads = {r["project_id"]: r.get("last_read_at") for r in await reads_cur.to_list(length=2000)}
    # 3) Por proyecto, calcular canales accesibles y contar mensajes nuevos.
    out: dict = {}
    for pid in pids:
        # Cargar canales del proyecto.
        ch_docs = await db.channels.find({"project_id": pid}).to_list(length=200)
        # Filtrar canales accesibles para este usuario.
        ch_ids = [c["id"] for c in ch_docs if _can_access_channel(user, c)]
        if not ch_ids:
            out[pid] = 0
            continue
        last_read = reads.get(pid)
        q: dict = {
            "channel_id": {"$in": ch_ids},
            "user_id": {"$ne": user["id"]},
        }
        if last_read:
            q["created_at"] = {"$gt": last_read}
        count = await db.messages.count_documents(q)
        out[pid] = int(count)
    return out


# === EVENTS (Calendario compartido) ========================================
class EventIn(BaseModel):
    title: str
    description: Optional[str] = None
    location: Optional[str] = None
    start_at: str  # ISO 8601
    end_at: Optional[str] = None
    area_id: Optional[str] = None


class EventPatch(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    location: Optional[str] = None
    start_at: Optional[str] = None
    end_at: Optional[str] = None
    area_id: Optional[str] = None


def _event_out(doc: dict) -> dict:
    doc.pop("_id", None)
    return doc


async def _enrich_event_with_area(doc: dict) -> dict:
    """Adjunta area_name + area_color leyendo la colección areas (si hay area_id)."""
    aid = doc.get("area_id")
    if aid:
        a = await db.areas.find_one({"id": aid})
        if a:
            doc["area_name"] = a.get("name")
            doc["area_color"] = a.get("color")
        else:
            doc["area_name"] = None
            doc["area_color"] = None
    else:
        doc["area_name"] = None
        doc["area_color"] = None
    return doc


def _parse_iso(s: str) -> datetime:
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        raise HTTPException(400, f"Fecha inválida: {s}")


@api.get("/projects/{pid}/events")
async def list_events(
    pid: str,
    range: str = "upcoming",  # upcoming | past | all
    limit: int = 500,
    user: dict = Depends(current_user),
):
    """Lista eventos. Cualquier miembro del proyecto puede leer."""
    await ensure_project_access(user, pid)
    q: dict = {"project_id": pid}
    now = datetime.now(timezone.utc)
    if range == "upcoming":
        # eventos desde inicio del día actual (UTC) en adelante
        start_today = now.replace(hour=0, minute=0, second=0, microsecond=0)
        q["start_at"] = {"$gte": start_today}
    elif range == "past":
        q["start_at"] = {"$lt": now.replace(hour=0, minute=0, second=0, microsecond=0)}
    # 'all' → sin filtro

    sort_dir = 1 if range != "past" else -1
    safe_limit = max(1, min(int(limit or 500), 1000))
    cursor = db.events.find(q).sort("start_at", sort_dir).limit(safe_limit)
    items = await cursor.to_list(length=safe_limit)
    # Enriquecer con area_name + area_color (en batch).
    area_ids = {it.get("area_id") for it in items if it.get("area_id")}
    areas_by_id: dict = {}
    if area_ids:
        async for a in db.areas.find({"id": {"$in": list(area_ids)}}):
            areas_by_id[a["id"]] = {"name": a.get("name"), "color": a.get("color")}
    out = []
    for it in items:
        it = _event_out(it)
        aid = it.get("area_id")
        info = areas_by_id.get(aid) if aid else None
        it["area_name"] = (info or {}).get("name")
        it["area_color"] = (info or {}).get("color")
        out.append(it)
    return out


@api.post("/projects/{pid}/events")
async def create_event(
    pid: str,
    body: EventIn,
    user: dict = Depends(current_user),
):
    """Cualquier miembro del proyecto puede crear eventos."""
    await ensure_project_access(user, pid)
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(400, "Título requerido")
    if len(title) > 140:
        raise HTTPException(400, "Título máximo 140 caracteres")
    start = _parse_iso(body.start_at)
    end = _parse_iso(body.end_at) if body.end_at else None
    if end and end < start:
        raise HTTPException(400, "La fecha de fin no puede ser anterior al inicio")
    desc = (body.description or "").strip() or None
    loc = (body.location or "").strip() or None
    if desc and len(desc) > 2000:
        raise HTTPException(400, "Descripción máximo 2000 caracteres")
    if loc and len(loc) > 200:
        raise HTTPException(400, "Ubicación máximo 200 caracteres")
    area_id_val = (body.area_id or None) or None
    if area_id_val:
        a = await db.areas.find_one({"id": area_id_val, "project_id": pid})
        if not a:
            raise HTTPException(400, "Área inválida para este proyecto")
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "project_id": pid,
        "title": title,
        "description": desc,
        "location": loc,
        "start_at": start,
        "end_at": end,
        "area_id": area_id_val,
        "author_id": user["id"],
        "author_name": user["name"],
        "author_role": user["role"],
        "created_at": now,
        "updated_at": now,
    }
    await db.events.insert_one(doc)
    return await _enrich_event_with_area(_event_out(doc))


@api.patch("/events/{eid}")
async def update_event(
    eid: str,
    body: EventPatch,
    user: dict = Depends(current_user),
):
    """Editable por el autor o por cualquier Coordinador General."""
    e = await db.events.find_one({"id": eid})
    if not e:
        raise HTTPException(404, "Evento no existe")
    await ensure_project_access(user, e["project_id"])
    is_author = e.get("author_id") == user["id"]
    is_coord = user["role"] == ROLE_COORD
    if not (is_author or is_coord):
        raise HTTPException(403, "Sólo el autor o un Coordinador puede editar")
    update: dict = {}
    if body.title is not None:
        t = body.title.strip()
        if not t:
            raise HTTPException(400, "Título no puede estar vacío")
        if len(t) > 140:
            raise HTTPException(400, "Título máximo 140 caracteres")
        update["title"] = t
    if body.description is not None:
        d = body.description.strip()
        if d and len(d) > 2000:
            raise HTTPException(400, "Descripción máximo 2000 caracteres")
        update["description"] = d or None
    if body.location is not None:
        loc = body.location.strip()
        if loc and len(loc) > 200:
            raise HTTPException(400, "Ubicación máximo 200 caracteres")
        update["location"] = loc or None
    if body.start_at is not None:
        update["start_at"] = _parse_iso(body.start_at)
    if body.end_at is not None:
        update["end_at"] = _parse_iso(body.end_at) if body.end_at else None
    if body.area_id is not None:
        aid = (body.area_id or None) or None
        if aid:
            a = await db.areas.find_one({"id": aid, "project_id": e["project_id"]})
            if not a:
                raise HTTPException(400, "Área inválida para este proyecto")
        update["area_id"] = aid
    start_final = update.get("start_at", e["start_at"])
    end_final = update.get("end_at", e.get("end_at"))
    if end_final and end_final < start_final:
        raise HTTPException(400, "La fecha de fin no puede ser anterior al inicio")
    if not update:
        return await _enrich_event_with_area(_event_out(e))
    update["updated_at"] = datetime.now(timezone.utc)
    await db.events.update_one({"id": eid}, {"$set": update})
    e = await db.events.find_one({"id": eid})
    return await _enrich_event_with_area(_event_out(e))


@api.delete("/events/{eid}")
async def delete_event(eid: str, user: dict = Depends(current_user)):
    """Eliminable por el autor o por cualquier Coordinador General."""
    e = await db.events.find_one({"id": eid})
    if not e:
        raise HTTPException(404, "Evento no existe")
    await ensure_project_access(user, e["project_id"])
    is_author = e.get("author_id") == user["id"]
    is_coord = user["role"] == ROLE_COORD
    if not (is_author or is_coord):
        raise HTTPException(403, "Sólo el autor o un Coordinador puede eliminar")
    await db.events.delete_one({"id": eid})
    return {"ok": True}


# === EXPORT (Excel "sábana plana" jerárquica) ===============================
def _flatten_tree_in_order(nodes_by_id: dict, root_ids: list) -> list:
    """Devuelve los nodos en pre-order (raíz → hijos por order), aplanando el árbol.
    Sólo retorna nodos hoja (los que pueden tener reportes asociados)."""
    out: list = []
    def visit(nid: str):
        n = nodes_by_id.get(nid)
        if not n:
            return
        if n.get("is_leaf"):
            out.append(n)
        # Recorre hijos ordenados
        children = sorted(
            [c for c in nodes_by_id.values() if c.get("parent_id") == nid],
            key=lambda x: (x.get("order", 0), x.get("name", "")),
        )
        for c in children:
            visit(c["id"])
    for rid in root_ids:
        visit(rid)
    return out


def _excel_safe(value) -> object:
    """Convierte valores no-nativos a algo que openpyxl pueda escribir."""
    if value is None:
        return ""
    if isinstance(value, datetime):
        # openpyxl maneja datetime nativo; quitamos tz para Excel.
        return value.replace(tzinfo=None) if value.tzinfo else value
    if isinstance(value, (list, tuple)):
        return ", ".join(str(v) for v in value if v is not None and str(v).strip())
    if isinstance(value, dict):
        # Aplana dict simple
        return ", ".join(f"{k}={v}" for k, v in value.items() if v is not None)
    return value


@api.get("/projects/{pid}/export/reports.xlsx")
async def export_reports_xlsx(pid: str, user: dict = Depends(current_user)):
    """Exporta TODOS los reportes del proyecto en una sábana Excel plana,
    iterando los nodos en orden jerárquico (Tramo → Estación → Poste).
    Incluye ruta del nodo y coordenadas dictadas (X, Y, Z). Acceso para
    cualquier rol que pertenezca al proyecto (ensure_project_access)."""
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill, Alignment
    except Exception as e:
        raise HTTPException(500, f"openpyxl no instalado: {e}")

    await ensure_project_access(user, pid)
    proj = await db.projects.find_one({"id": pid})
    if not proj:
        raise HTTPException(404, "Proyecto no existe")

    # Carga árbol completo del proyecto
    nodes_raw = await db.location_nodes.find({"project_id": pid}).to_list(length=10000)
    nodes_by_id = {n["id"]: n for n in nodes_raw}
    root_ids = [n["id"] for n in nodes_raw if not n.get("parent_id")]
    # Ordena raíces por (order, name)
    root_ids.sort(key=lambda nid: (nodes_by_id[nid].get("order", 0), nodes_by_id[nid].get("name", "")))
    leaf_nodes = _flatten_tree_in_order(nodes_by_id, root_ids)
    leaf_ids = [n["id"] for n in leaf_nodes]
    leaf_index = {nid: i for i, nid in enumerate(leaf_ids)}

    # Trae todos los reportes y agrúpalos por node_id
    reports = await db.reports.find({"project_id": pid}).to_list(length=20000)

    # Áreas para resolver nombres
    areas = await db.areas.find({"project_id": pid}).to_list(length=500)
    areas_by_id = {a["id"]: a for a in areas}

    # Construir workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Reportes"

    headers = [
        "Orden",                   # índice de orden jerárquico del nodo hoja
        "Tipo de medición",
        "Ruta completa",            # Tramo > Estación > Poste
        "Nodo (hoja)",
        "Latitud objetivo (X)",
        "Longitud objetivo (Y)",
        "Elevación objetivo (Z)",
        "Valor capturado",          # measurement_value (string)
        "Avance",
        "Contratista",
        "Personal",
        "Equipo",
        "Notas / Observaciones",
        "Área",
        "Capturado por",
        "Fecha de captura",
        "ID Reporte",
    ]
    ws.append(headers)

    # Estilo cabecera
    header_fill = PatternFill(start_color="1E3A8A", end_color="1E3A8A", fill_type="solid")
    header_font = Font(color="FFFFFF", bold=True)
    for col_idx in range(1, len(headers) + 1):
        c = ws.cell(row=1, column=col_idx)
        c.fill = header_fill
        c.font = header_font
        c.alignment = Alignment(horizontal="center", vertical="center")
    ws.freeze_panes = "A2"

    # Recorre los nodos hoja en orden y escribe sus reportes
    for n in leaf_nodes:
        node_reports = [r for r in reports if r.get("node_id") == n["id"]]
        # Orden secundario: por fecha de captura descendente
        node_reports.sort(key=lambda r: r.get("created_at") or datetime.min, reverse=True)
        full_path = " > ".join((await node_path_names(n["id"])))
        target_lat = n.get("target_lat")
        target_lon = n.get("target_lon")
        target_elev = n.get("target_elev")
        if not node_reports:
            # Aún así dejamos una fila por nodo hoja (vacía) para mantener trazabilidad.
            ws.append([
                leaf_index[n["id"]] + 1,
                n.get("measurement_type") or "",
                full_path,
                n.get("name"),
                target_lat if target_lat is not None else "",
                target_lon if target_lon is not None else "",
                target_elev if target_elev is not None else "",
                "(sin reporte)",
                "", "", "", "", "", "", "", "", "",
            ])
            continue
        for r in node_reports:
            personnel = r.get("personnel") or []
            equipment = r.get("equipment") or []
            ws.append([
                leaf_index[n["id"]] + 1,
                r.get("measurement_type") or n.get("measurement_type") or "",
                full_path,
                n.get("name"),
                _excel_safe(target_lat),
                _excel_safe(target_lon),
                _excel_safe(target_elev),
                _excel_safe(r.get("measurement_value")),
                _excel_safe(r.get("avance")),
                _excel_safe(r.get("contratista")),
                _excel_safe(personnel),
                _excel_safe(equipment),
                _excel_safe(r.get("notes")),
                _excel_safe(r.get("area_name") or (areas_by_id.get(r.get("area_id"), {}) or {}).get("name") or ""),
                _excel_safe(r.get("captured_by_name")),
                _excel_safe(r.get("created_at")),
                r.get("id"),
            ])

    # Anchos de columna
    widths = [7, 18, 44, 22, 16, 16, 16, 24, 14, 18, 30, 26, 36, 18, 22, 22, 38]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = w
    # Wrap en columnas largas
    wrap_cols = {3, 11, 12, 13}  # Ruta, Personal, Equipo, Notas
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            if cell.column in wrap_cols:
                cell.alignment = Alignment(wrap_text=True, vertical="top")

    # Cabecera del archivo: nombre del proyecto y fecha
    ws.insert_rows(1)
    ws.cell(row=1, column=1, value=f"SynCo · {proj.get('name','Proyecto')} · Reporte exportado {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(headers))
    title_cell = ws.cell(row=1, column=1)
    title_cell.font = Font(bold=True, size=12, color="1E3A8A")
    title_cell.alignment = Alignment(horizontal="left", vertical="center")
    ws.freeze_panes = "A3"

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    safe_name = re.sub(r"[^A-Za-z0-9_-]+", "_", proj.get("name", "proyecto"))[:60] or "proyecto"
    fname = f"synco_{safe_name}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M')}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# === PDF EXPORT (Motor paramétrico unificado v2) =============================
# Reglas:
#   - COORDINADOR: ve TODOS los reportes del proyecto.
#   - ESPECIALISTA: sólo ve los reportes que ÉL capturó (captured_by == user.id).
#   - SUB-COORDINADOR: ve sólo reportes cuyos nodos caen dentro de su scope_node_ids.
#   - Período: today | yesterday | week | month (ventana móvil sobre created_at).
#   - "Mes" = Mes-a-la-fecha (día 1 → ahora). NO últimos 30 días.
#   - Render reportlab CPU-bound se ejecuta en thread aparte (asyncio.to_thread)
#     para no bloquear el event loop de uvicorn en "week"/"month".
#   - Cálculo de Avance: por cada reporte → (Última lectura - Primera lectura),
#     donde Primera lectura = último valor capturado en el reporte anterior del
#     mismo nodo (o 0 si es el primer reporte histórico).
#   - Layout exacto por reporte: Fecha · Nombre · Actividad · No. De Contrato ·
#     Contratista · Ubicación · Reporte de avance · Personal · Equipo · Observaciones.

LOGO_PATH = Path(__file__).resolve().parent / "assets" / "logo_dirac.png"

_MESES_ES = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
]

_MEASUREMENT_LABELS_ES = {
    "coord_latlon": "Coordenadas (Lat/Lon)",
    "cadenamiento": "Cadenamiento",
    "eje": "Eje",
    "nivel": "Nivel",
}


def _measurement_label(mtype: str) -> str:
    return _MEASUREMENT_LABELS_ES.get(mtype or "", mtype or "—")


def _fmt_fecha_es(dt: datetime) -> str:
    """Formato ej. '16 de Junio del 2026' en zona horaria America/Mexico_City."""
    try:
        if not isinstance(dt, datetime):
            return "—"
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        dt = dt.astimezone(MX_TZ)
        return f"{dt.day} de {_MESES_ES[dt.month - 1]} del {dt.year}"
    except Exception:
        return dt.strftime("%Y-%m-%d") if isinstance(dt, datetime) else "—"


def _fmt_fecha_dd_mm_yyyy(dt) -> str:
    """Formato corto DD-MM-YYYY en zona horaria America/Mexico_City.

    Nunca regresa palabras como "Hoy" o "Ayer" — es el formato institucional
    requerido en exportaciones."""
    try:
        if not isinstance(dt, datetime):
            return "—"
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        dt = dt.astimezone(MX_TZ)
        return dt.strftime("%d-%m-%Y")
    except Exception:
        return "—"


def _fmt_fecha_dd_mm_yyyy_hhmm(dt) -> str:
    """Formato DD-MM-YYYY HH:MM en zona horaria America/Mexico_City."""
    try:
        if not isinstance(dt, datetime):
            return "—"
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        dt = dt.astimezone(MX_TZ)
        return dt.strftime("%d-%m-%Y %H:%M")
    except Exception:
        return "—"


_SEVERIDAD_ORDER = {"urgente": 0, "importante": 1, "informativo": 2}


def _severidad_label(sev: Optional[str]) -> str:
    s = (sev or "informativo").lower()
    return {"urgente": "Urgente", "importante": "Importante", "informativo": "Informativo"}.get(s, "Informativo")


def _severidad_hex(sev: Optional[str]) -> str:
    s = (sev or "informativo").lower()
    # Semáforo institucional: rojo / ámbar / azul.
    return {"urgente": "#DC2626", "importante": "#D97706", "informativo": "#1D4ED8"}.get(s, "#1D4ED8")


def _export_severity_filter(role: str) -> set:
    """Severidades incluidas en el documento exportado según rol del usuario.

    - Especialista: Importante + Urgente (excluye Informativo).
    - Supervisor (sub-coord, jefe, coord): Importante + Urgente.
    - Esta regla aplica a reportes Y noticias inyectadas."""
    return {"importante", "urgente"}


async def _announcements_for_node(
    pid: str,
    node_path_ids: List[str],
    start_dt: datetime,
    end_dt: datetime,
) -> List[dict]:
    """Devuelve noticias vinculadas al nodo o cualquiera de sus ancestros,
    con severidad Importante/Urgente, en el rango [start_dt, end_dt]."""
    if not node_path_ids:
        return []
    q = {
        "project_id": pid,
        "jerarquia": {"$in": ["importante", "urgente"]},
        "$or": [
            {"node_id": {"$in": node_path_ids}},
            {"node_path_ids": {"$elemMatch": {"$in": node_path_ids}}},
        ],
        "created_at": {"$gte": start_dt, "$lte": end_dt},
    }
    items = await db.announcements.find(q).sort("created_at", -1).to_list(length=200)
    return items


def _extract_numeric_reading(report: dict) -> Optional[float]:
    """Extrae el valor numérico capturado en el reporte según measurement_type.
    Retorna None si no se puede convertir a número (ej. 'eje', coordenadas)."""
    if not report:
        return None
    mtype = report.get("measurement_type")
    val = report.get("measurement_value") or {}
    try:
        if mtype == "nivel":
            v = val.get("nivel") if "nivel" in val else val.get("value")
            return float(v) if v is not None else None
        if mtype == "cadenamiento":
            v = val.get("cadenamiento") or val.get("value")
            if isinstance(v, str) and "+" in v:
                parts = v.split("+", 1)
                km = float(parts[0])
                m = float(parts[1])
                return km * 1000.0 + m
            return float(v) if v is not None else None
        # eje / coord_latlon → no numérico
        return None
    except Exception:
        return None


def _fmt_reading(v: Optional[float]) -> str:
    """Formato profesional con máximo 2 decimales (sin ceros sobrantes)."""
    if v is None:
        return "—"
    try:
        f = float(v)
    except Exception:
        return "—"
    if abs(f - round(f)) < 1e-9:
        return f"{int(round(f))}"
    s = f"{f:.2f}"
    # Quita ceros sobrantes a la derecha (p.ej. 12.50 → 12.5) pero respeta el
    # punto decimal: 12.00 ya quedaría como entero por la rama anterior.
    if "." in s:
        s = s.rstrip("0").rstrip(".") if s.endswith("0") else s
    return s


def _format_measurement_for_display(report: dict) -> str:
    """Cuando no hay valor numérico (ej. eje, coord), devolvemos representación legible."""
    mtype = (report or {}).get("measurement_type")
    val = (report or {}).get("measurement_value") or {}
    if mtype == "eje":
        return str(val.get("eje") or val.get("value") or "—")
    if mtype == "coord_latlon":
        lat = val.get("lat"); lon = val.get("lon")
        if lat is None or lon is None:
            return "—"
        try:
            return f"{float(lat):.6f}, {float(lon):.6f}"
        except Exception:
            return f"{lat}, {lon}"
    if mtype == "cadenamiento":
        return str(val.get("cadenamiento") or val.get("value") or "—")
    if mtype == "nivel":
        v = val.get("nivel") if "nivel" in val else val.get("value")
        return _fmt_reading(float(v)) if v is not None else "—"
    return "—"


def _period_range(period: str) -> tuple:
    """Devuelve (start_utc, end_utc, etiqueta_legible).

    Los rangos se calculan en horario local America/Mexico_City y se
    convierten a UTC para consultar Mongo. Esto garantiza:
      - "Hoy" = desde 00:00:00 CDMX del día actual.
      - "Ayer" = el día calendario anterior (00:00–24:00 CDMX).
      - "Mes" = REGLA ESTRICTA: día 1 del mes calendario actual CDMX 00:00:00 → ahora.
    """
    now_utc = datetime.now(timezone.utc)
    now_mx = now_utc.astimezone(MX_TZ)
    p = (period or "today").lower().strip()
    if p in ("today", "hoy"):
        start_mx = now_mx.replace(hour=0, minute=0, second=0, microsecond=0)
        return start_mx.astimezone(timezone.utc), now_utc, "Hoy"
    if p in ("yesterday", "ayer"):
        end_mx = now_mx.replace(hour=0, minute=0, second=0, microsecond=0)
        start_mx = end_mx - timedelta(days=1)
        return start_mx.astimezone(timezone.utc), end_mx.astimezone(timezone.utc), "Ayer"
    if p in ("week", "semana", "semanal"):
        start_mx = now_mx - timedelta(days=7)
        return start_mx.astimezone(timezone.utc), now_utc, "Última semana"
    if p in ("month", "mes", "mensual"):
        # REGLA ESTRICTA: Día 1 del mes calendario CDMX 00:00 → ahora.
        start_mx = now_mx.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        return start_mx.astimezone(timezone.utc), now_utc, "Mes a la fecha"
    start_mx = now_mx.replace(hour=0, minute=0, second=0, microsecond=0)
    return start_mx.astimezone(timezone.utc), now_utc, "Hoy"


def _strip_b64_prefix(s: str) -> str:
    if not isinstance(s, str):
        return ""
    if s.startswith("data:") and "," in s:
        return s.split(",", 1)[1]
    return s


# ============================================================================
# Logo institucional por defecto (DIRAC) — cache en memoria.
# Si el proyecto NO tiene `constructora_logo` configurado, las exportaciones
# usan el logo DIRAC para que la cabecera/portada nunca quede vacía.
# ============================================================================
_DIRAC_LOGO_URL = (
    "https://customer-assets.emergentagent.com/"
    "job_offline-report-sync/artifacts/k58zlgpr_Logo%20dirac%20.png"
)
_DIRAC_LOGO_LOCAL = Path(__file__).resolve().parent / "assets" / "logo_dirac.png"
_DIRAC_LOGO_CACHE: dict = {"bytes": None, "tried": False}


def _get_default_logo_bytes() -> Optional[bytes]:
    """Devuelve los bytes del logo DIRAC (logotipo institucional con triángulo
    verde). Prioriza el archivo local en `backend/assets/logo_dirac.png` y, si
    no existe, intenta una descarga remota como fallback.

    Si todo falla, devuelve None y los exports renderizan sin logo.
    """
    if _DIRAC_LOGO_CACHE["bytes"] is not None:
        return _DIRAC_LOGO_CACHE["bytes"]
    if _DIRAC_LOGO_CACHE["tried"]:
        return None
    _DIRAC_LOGO_CACHE["tried"] = True
    # 1) Archivo local — preferido por confiabilidad y por evitar dependencias de red.
    try:
        if _DIRAC_LOGO_LOCAL.exists():
            data = _DIRAC_LOGO_LOCAL.read_bytes()
            if data:
                _DIRAC_LOGO_CACHE["bytes"] = data
                return data
    except Exception as e:  # pragma: no cover
        logging.warning("No se pudo leer logo DIRAC local: %s", e)
    # 2) Fallback remoto.
    try:
        import requests as _http
        resp = _http.get(_DIRAC_LOGO_URL, timeout=6)
        if resp.status_code == 200 and resp.content:
            _DIRAC_LOGO_CACHE["bytes"] = resp.content
            return resp.content
    except Exception as e:  # pragma: no cover
        logging.warning("No se pudo descargar logo DIRAC: %s", e)
    return None


def _resolve_export_logo_bytes(proj_logo_b64: Optional[str]) -> Optional[bytes]:
    """Devuelve los bytes del logo institucional priorizando el del proyecto.

    1) Si el proyecto tiene `constructora_logo` (base64), lo usa.
    2) Si no, cae al logo DIRAC por defecto (cacheado).
    3) Si todo falla, retorna None y las exportaciones omiten el logo.
    """
    import base64 as _b64
    if proj_logo_b64:
        try:
            return _b64.b64decode(_strip_b64_prefix(proj_logo_b64))
        except Exception:
            pass
    return _get_default_logo_bytes()


@api.get("/projects/{pid}/export/reports.pdf")
async def export_reports_pdf(
    pid: str,
    period: str = Query("today", description="today|yesterday|week|month"),
    area_id: Optional[str] = Query(None, description="Filtro por área (opcional)"),
    scope: Optional[str] = Query(None, description="mine|area (para especialistas)"),
    user: dict = Depends(current_user),
):
    """Motor PDF paramétrico.

    Filtros aplicados automáticamente (no negociables):
      - Severidad: SOLO Importante + Urgente (excluye Informativo).
      - Área: si `area_id` se especifica, filtra por esa área.
      - Especialistas con toggle `scope=mine` ven solo sus reportes.
    Render bloqueante (reportlab) en thread aparte."""
    try:
        import base64
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.units import cm
        from reportlab.lib.colors import HexColor
        from reportlab.lib.utils import ImageReader
        from reportlab.pdfgen import canvas as _canvas
    except Exception as e:
        raise HTTPException(500, f"reportlab no instalado: {e}")

    scope_mine_only = (scope or "").lower() == "mine"
    data = await _gather_export_data(pid, period, user, area_id=area_id, scope_mine_only=scope_mine_only)
    proj = data["proj"]
    leaf_nodes = data["leaf_nodes"]
    reports_by_node = data["reports_by_node"]
    announcements_by_node = data["announcements_by_node"]
    path_cache = data["path_cache"]
    start_dt = data["start_dt"]
    end_dt = data["end_dt"]
    prev_reading_by_node = data["prev_reading_by_node"]

    role = user["role"]

    # Snapshot inmutable para el thread bloqueante
    project_name = proj.get("name", "Proyecto")
    project_contract = proj.get("contract_number") or "—"
    project_constructora = proj.get("constructora") or "—"
    project_objeto = proj.get("objeto_contrato") or None
    project_cliente = (proj.get("cliente_principal") or "").strip() or None
    project_color = _sanitize_color_hex(proj.get("color_tema")) or "#003366"
    constructora_logo_b64 = (proj.get("constructora_logo") or "").strip() or None
    user_name = user.get("name", "")
    user_email = user.get("email", "")
    role_label = (
        "Coordinador" if role == ROLE_COORD
        else ("Especialista" if role == ROLE_ESPECIALISTA else "Sub-Coordinador")
    )
    # Etiqueta de área seleccionada (para portada)
    area_label = "Todas las áreas"
    if area_id:
        area = await db.areas.find_one({"id": area_id, "project_id": pid})
        if area:
            area_label = f"Área: {area.get('name', '—')}"

    # Rango DD-MM-YYYY (sin "Hoy"/"Ayer")
    fechas_label = f"{_fmt_fecha_dd_mm_yyyy(start_dt)} a {_fmt_fecha_dd_mm_yyyy(end_dt)}"

    # ========================================================================
    # GENERACIÓN BLOQUEANTE (CPU-bound) → asyncio.to_thread
    # ========================================================================
    def _build_pdf_blocking() -> bytes:
        buf = io.BytesIO()
        PAGE = landscape(A4)  # 29.7 x 21 cm
        PW, PH = PAGE
        c = _canvas.Canvas(buf, pagesize=PAGE)

        BRAND = HexColor(project_color)
        MUTED = HexColor("#64748B")
        BORDER = HexColor("#E2E8F0")
        TEXT = HexColor("#0F172A")
        WHITE = HexColor("#FFFFFF")

        # Bytes del logo institucional: prioriza el del proyecto, fallback DIRAC.
        # Cargamos UNA SOLA VEZ para todo el PDF.
        logo_bytes = _resolve_export_logo_bytes(constructora_logo_b64)
        logo_reader = None
        if logo_bytes:
            try:
                logo_reader = ImageReader(io.BytesIO(logo_bytes))
            except Exception:
                logo_reader = None

        def _draw_logo(x, y, max_w, max_h):
            """Dibuja el logo institucional (constructora o DIRAC) en (x, y)."""
            if logo_reader is None:
                return False
            try:
                c.drawImage(logo_reader, x, y, width=max_w, height=max_h,
                            preserveAspectRatio=True, mask='auto')
                return True
            except Exception:
                return False

        def draw_header(page_num: int):
            # Logo institucional (constructora) en esquina superior izquierda
            _draw_logo(1.2 * cm, PH - 2.0 * cm, 3.5 * cm, 1.4 * cm)
            c.setFillColor(BRAND)
            c.setFont("Helvetica-Bold", 11)
            c.drawString(5.2 * cm, PH - 1.2 * cm, project_name)
            c.setFillColor(MUTED)
            c.setFont("Helvetica", 8)
            c.drawString(5.2 * cm, PH - 1.6 * cm,
                         f"{project_constructora}  ·  Contrato {project_contract}  ·  Exportado {_fmt_fecha_dd_mm_yyyy_hhmm(datetime.now(timezone.utc))}")
            c.setStrokeColor(BORDER)
            c.setLineWidth(0.5)
            c.line(1.2 * cm, PH - 2.0 * cm, PW - 1.2 * cm, PH - 2.0 * cm)
            c.setFillColor(MUTED)
            c.setFont("Helvetica", 7)
            c.drawRightString(PW - 1.2 * cm, 0.8 * cm, f"Página {page_num}")

        # --- PORTADA INSTITUCIONAL ----------------------------------------
        # Fondo completo en color_tema del proyecto. Bloque superior con logo
        # y cliente_principal, bloque central con título y objeto del contrato
        # en letras blancas, y pie con período/responsable.
        page_num = 1
        c.setFillColor(BRAND)
        c.rect(0, 0, PW, PH, stroke=0, fill=1)
        # Banda blanca translúcida en la parte superior para el logo
        c.setFillColor(WHITE)
        c.setFillAlpha(0.92)
        c.rect(0, PH - 4.5 * cm, PW, 4.5 * cm, stroke=0, fill=1)
        c.setFillAlpha(1.0)
        _draw_logo(1.5 * cm, PH - 4.0 * cm, 5.0 * cm, 3.0 * cm)
        # Cliente principal arriba a la derecha
        if project_cliente:
            c.setFillColor(BRAND)
            c.setFont("Helvetica-Bold", 11)
            c.drawRightString(PW - 1.5 * cm, PH - 2.0 * cm, "CLIENTE")
            c.setFillColor(TEXT)
            c.setFont("Helvetica-Bold", 16)
            c.drawRightString(PW - 1.5 * cm, PH - 2.8 * cm, project_cliente[:60])
        # Título principal
        c.setFillColor(WHITE)
        c.setFont("Helvetica-Bold", 12)
        c.drawCentredString(PW / 2, PH - 7.5 * cm, "INFORME DE AVANCE Y SUPERVISIÓN")
        c.setFont("Helvetica-Bold", 32)
        # Nombre del proyecto (wrap si es largo)
        proj_words = project_name.split()
        proj_l1, proj_l2 = "", ""
        for w in proj_words:
            if c.stringWidth((proj_l1 + " " + w).strip(), "Helvetica-Bold", 32) < (PW - 4 * cm):
                proj_l1 = (proj_l1 + " " + w).strip()
            else:
                proj_l2 = (proj_l2 + " " + w).strip()
        c.drawCentredString(PW / 2, PH - 9.5 * cm, proj_l1)
        if proj_l2:
            c.drawCentredString(PW / 2, PH - 10.8 * cm, proj_l2[:80])
        # Objeto del contrato — texto blanco grande
        if project_objeto:
            c.setFillColor(WHITE)
            c.setFont("Helvetica-Oblique", 14)
            # wrap en hasta 3 líneas
            obj_words = project_objeto.split()
            lines = [""]
            for w in obj_words:
                tentative = (lines[-1] + " " + w).strip()
                if c.stringWidth(tentative, "Helvetica-Oblique", 14) < (PW - 6 * cm):
                    lines[-1] = tentative
                else:
                    if len(lines) >= 3:
                        break
                    lines.append(w)
            base_y = PH - 13.0 * cm
            for i, ln in enumerate(lines[:3]):
                c.drawCentredString(PW / 2, base_y - i * 0.7 * cm, ln)
        # Pie de la portada: período, responsable, contrato
        c.setFillColor(WHITE)
        c.setFillAlpha(0.3)
        c.rect(0, 2.2 * cm, PW, 0.05 * cm, stroke=0, fill=1)
        c.setFillAlpha(1.0)
        c.setFillColor(WHITE)
        c.setFont("Helvetica-Bold", 11)
        c.drawString(1.5 * cm, 4.2 * cm, "PERÍODO")
        c.setFont("Helvetica", 12)
        c.drawString(1.5 * cm, 3.5 * cm, fechas_label)
        c.setFont("Helvetica-Bold", 11)
        c.drawString(11 * cm, 4.2 * cm, role_label.upper())
        c.setFont("Helvetica", 12)
        c.drawString(11 * cm, 3.5 * cm, user_name)
        c.setFont("Helvetica-Bold", 11)
        c.drawRightString(PW - 1.5 * cm, 4.2 * cm, "CONTRATO")
        c.setFont("Helvetica", 12)
        c.drawRightString(PW - 1.5 * cm, 3.5 * cm, project_contract)
        # Total reportes (línea inferior)
        total_reportes = sum(len(v) for v in reports_by_node.values())
        c.setFont("Helvetica-Oblique", 10)
        c.drawCentredString(PW / 2, 1.4 * cm,
                            f"{area_label} · {total_reportes} reporte(s) incluido(s)")
        c.showPage()
        page_num += 1

        if total_reportes == 0:
            draw_header(page_num)
            c.setFillColor(MUTED)
            c.setFont("Helvetica-Oblique", 14)
            c.drawCentredString(PW / 2, PH / 2, "No hay reportes para el período seleccionado.")
            c.showPage()
            c.save()
            return buf.getvalue()

        # --- CUERPO ---------------------------------------------------------
        PHOTO_W = 10.0 * cm
        PHOTO_H = 13.37 * cm

        def render_text_block(x, y, max_w, lines, font="Helvetica", size=9, leading=12):
            c.setFont(font, size)
            c.setFillColor(TEXT)
            cy = y
            for ln in lines:
                if cy < 1.5 * cm:
                    break
                words = (ln or "").split(" ")
                current = ""
                for w in words:
                    test = (current + " " + w).strip()
                    if c.stringWidth(test, font, size) > max_w:
                        c.drawString(x, cy, current)
                        cy -= leading
                        current = w
                        if cy < 1.5 * cm:
                            return cy
                    else:
                        current = test
                if current:
                    c.drawString(x, cy, current)
                    cy -= leading
            return cy

        for n in leaf_nodes:
            node_reps = reports_by_node.get(n["id"]) or []
            if not node_reps:
                continue
            node_path = path_cache.get(n["id"]) or n.get("name", "")
            # Acumulado de "Primera lectura" — arranca con el último valor previo
            # al periodo (o 0 si es el primer reporte histórico del nodo).
            primera_acc = prev_reading_by_node.get(n["id"])
            if primera_acc is None:
                primera_acc = 0.0

            # =================================================================
            # [P0] PORTADA SEPARADORA POR NODO
            #   Página dedicada antes de los reportes del nodo:
            #     - Ubicación: 24pt Bold centrado
            #     - Coordenadas: 14pt centrado
            # =================================================================
            draw_header(page_num)
            # Bloque visual centrado vertical
            c.setFillColor(BRAND)
            c.setFont("Helvetica-Bold", 24)
            c.drawCentredString(PW / 2, PH / 2 + 1.6 * cm, node_path)
            # Línea decorativa
            c.setStrokeColor(BRAND)
            c.setLineWidth(1.2)
            c.line(PW / 2 - 6 * cm, PH / 2 + 0.8 * cm, PW / 2 + 6 * cm, PH / 2 + 0.8 * cm)
            # Coordenadas (medición representativa del nodo: tomada del primer reporte)
            coord_text = ""
            try:
                coord_text = _format_measurement_for_display(node_reps[0]) or ""
            except Exception:
                coord_text = ""
            c.setFillColor(TEXT)
            c.setFont("Helvetica", 14)
            if coord_text:
                c.drawCentredString(PW / 2, PH / 2 - 0.2 * cm, f"Coordenadas: {coord_text}")
            else:
                c.setFillColor(MUTED)
                c.setFont("Helvetica-Oblique", 14)
                c.drawCentredString(PW / 2, PH / 2 - 0.2 * cm, "Coordenadas: —")
            # Conteo de reportes del nodo
            c.setFillColor(MUTED)
            c.setFont("Helvetica", 11)
            c.drawCentredString(PW / 2, PH / 2 - 1.6 * cm,
                                f"Reportes en este nodo: {len(node_reps)}")
            # Salto de página obligatorio para iniciar el bloque del nodo
            c.showPage()
            page_num += 1

            for r in node_reps:
                draw_header(page_num)

                # === Foto centrada 10 x 13.37 cm =========================
                photo_x = (PW - PHOTO_W) / 2
                photo_y = PH - 2.3 * cm - PHOTO_H
                c.setStrokeColor(BORDER)
                c.setLineWidth(0.8)
                c.rect(photo_x, photo_y, PHOTO_W, PHOTO_H)
                img_b64 = None
                imgs = r.get("images") or []
                if imgs:
                    img_b64 = _strip_b64_prefix(imgs[0])
                if img_b64:
                    try:
                        raw = base64.b64decode(img_b64)
                        img = ImageReader(io.BytesIO(raw))
                        c.drawImage(img, photo_x, photo_y, width=PHOTO_W, height=PHOTO_H,
                                    preserveAspectRatio=True, mask='auto')
                    except Exception:
                        c.setFillColor(MUTED)
                        c.setFont("Helvetica-Oblique", 10)
                        c.drawCentredString(PW / 2, photo_y + PHOTO_H / 2, "(imagen no legible)")
                else:
                    c.setFillColor(MUTED)
                    c.setFont("Helvetica-Oblique", 10)
                    c.drawCentredString(PW / 2, photo_y + PHOTO_H / 2, "(sin fotografía)")

                # === Contador "Foto 1 de N" si hay múltiples imágenes ======
                if len(imgs) > 1:
                    c.setFillColor(MUTED)
                    c.setFont("Helvetica-Oblique", 8)
                    c.drawCentredString(
                        photo_x + PHOTO_W / 2,
                        photo_y - 0.35 * cm,
                        f"Foto 1 de {len(imgs)}",
                    )

                # === Bloque de datos a la derecha de la foto ==============
                data_x = photo_x + PHOTO_W + 0.8 * cm
                data_w = PW - data_x - 1.2 * cm
                cy = PH - 2.6 * cm

                # [P0 FIX] Lectura DIRECTA desde la BD — sin lógica condicional
                # por measurement_type. Se eliminó la regla hardcodeada que
                # secuestraba "Coordenadas" forzando ultima="X, Y" y avance="—".
                # Ahora se imprime SIEMPRE lo que viene del documento.
                def _raw_to_str(v):
                    if v is None or v == "":
                        return "—"
                    try:
                        return _fmt_reading(float(v))
                    except Exception:
                        return str(v).strip() or "—"

                primera_str = _raw_to_str(r.get("primera_lectura"))
                ultima_str = _raw_to_str(r.get("ultima_lectura"))
                _av = r.get("avance")
                avance_str = str(_av).strip() if _av not in (None, "") else "—"

                ts = r.get("created_at")
                fecha_str = _fmt_fecha_dd_mm_yyyy(ts) if isinstance(ts, datetime) else "—"
                nombre = r.get("captured_by_name") or "—"
                # Constructora siempre desde el proyecto
                contratista = (project_constructora or "").strip() or "N/A"
                unidad_r = (r.get("unidad") or "m").strip() or "m"
                personal_list = [p for p in (r.get("personnel") or []) if p]
                equipo_list = [e for e in (r.get("equipment") or []) if e]
                personal_str = ", ".join(personal_list) if personal_list else "N/A"
                equipo_str = ", ".join(equipo_list) if equipo_list else "N/A"
                obs_str = (r.get("observaciones") or r.get("notes") or "").strip() or "N/A"
                incidencias_str = (r.get("incidencias") or "").strip() or None

                def field(label: str, value, font="Helvetica", size=9.5, leading=12):
                    nonlocal cy
                    c.setFillColor(BRAND)
                    c.setFont("Helvetica-Bold", 9)
                    c.drawString(data_x, cy, label.upper())
                    cy -= 0.42 * cm
                    cy = render_text_block(data_x, cy, data_w, [str(value)],
                                           font=font, size=size, leading=leading)
                    cy -= 0.20 * cm

                # ====== Orden institucional de campos ======
                field("Fecha", fecha_str)
                field("Especialista", nombre)
                field("Constructora", contratista)
                field("No. de Contrato", project_contract)
                field("Nodo / Ubicación", node_path)
                field("Reporte de avance",
                      f"Primera lectura: {primera_str} {unidad_r}    |    Última lectura: {ultima_str} {unidad_r}    |    Avance: {avance_str}")
                # SITUACIÓN SOCIAL: imprime incidencias o "Sin incidencias"
                field("Situación social",
                      incidencias_str if incidencias_str else "Sin incidencias.")
                # ACTIVIDADES: imprime observaciones / avance descriptivo + métricas
                actividades_lines = []
                if obs_str and obs_str != "N/A":
                    actividades_lines.append(obs_str)
                actividades_lines.append(
                    f"Métricas — Primera lectura: {primera_str} {unidad_r} · "
                    f"Última lectura: {ultima_str} {unidad_r} · Avance: {avance_str}."
                )
                field("Actividades", " ".join(actividades_lines))
                field("Personal", personal_str)
                field("Equipo", equipo_str)

                # Banner de severidad (semáforo) en esquina inferior derecha
                sev = (r.get("severidad") or "informativo").lower()
                sev_hex = _severidad_hex(sev)
                c.setFillColor(HexColor(sev_hex))
                c.roundRect(PW - 4.5 * cm, photo_y - 0.2 * cm - 0.6 * cm, 3.3 * cm, 0.7 * cm,
                            radius=4, stroke=0, fill=1)
                c.setFillColor(HexColor("#FFFFFF"))
                c.setFont("Helvetica-Bold", 10)
                c.drawCentredString(PW - 4.5 * cm + 1.65 * cm,
                                    photo_y - 0.2 * cm - 0.2 * cm,
                                    _severidad_label(sev).upper())

                # Pie del reporte
                c.setFillColor(MUTED)
                c.setFont("Helvetica-Oblique", 8)
                c.drawString(photo_x, photo_y - 0.5 * cm, f"Capturado por: {nombre}")

                c.showPage()
                page_num += 1

                # =====================================================
                # GALERÍA: fotos adicionales del MISMO reporte (si > 1)
                # Layout institucional: 2 fotos por página, lado a lado,
                # con tamaño exacto 13.37 cm (ancho) × 10 cm (alto).
                # =====================================================
                extra_imgs = imgs[1:] if len(imgs) > 1 else []
                if extra_imgs:
                    GAL_W = 13.37 * cm
                    GAL_H = 10.0 * cm
                    PER_PAGE = 2
                    n_extras = len(extra_imgs)
                    for chunk_start in range(0, n_extras, PER_PAGE):
                        chunk = extra_imgs[chunk_start:chunk_start + PER_PAGE]
                        draw_header(page_num)
                        # Encabezado de la galería
                        c.setFillColor(BRAND)
                        c.setFont("Helvetica-Bold", 14)
                        c.drawString(
                            1.5 * cm, PH - 3.0 * cm,
                            f"Fotografías adicionales · {node_path[:60]}",
                        )
                        c.setStrokeColor(BORDER)
                        c.setLineWidth(0.8)
                        c.line(1.5 * cm, PH - 3.2 * cm, PW - 1.5 * cm, PH - 3.2 * cm)
                        c.setFillColor(MUTED)
                        c.setFont("Helvetica-Oblique", 9)
                        c.drawString(
                            1.5 * cm, PH - 3.7 * cm,
                            f"Reporte de {fecha_str} · Página {chunk_start // PER_PAGE + 1} de "
                            f"{(n_extras + PER_PAGE - 1) // PER_PAGE}",
                        )
                        # Cálculo de posiciones: ambas fotos centradas verticalmente
                        # 2 fotos lado a lado: ancho total = 2*13.37 + gap
                        gap_x = 0.5 * cm
                        total_w = PER_PAGE * GAL_W + (PER_PAGE - 1) * gap_x
                        x0 = (PW - total_w) / 2
                        # Centrar verticalmente bajo el header
                        avail_top = PH - 4.0 * cm
                        avail_bot = 1.5 * cm
                        y_img = (avail_top + avail_bot - GAL_H) / 2
                        for idx, b64 in enumerate(chunk):
                            cx = x0 + idx * (GAL_W + gap_x)
                            c.setStrokeColor(BORDER)
                            c.setLineWidth(0.8)
                            c.rect(cx, y_img, GAL_W, GAL_H, stroke=1, fill=0)
                            try:
                                raw_g = base64.b64decode(_strip_b64_prefix(b64))
                                imgg = ImageReader(io.BytesIO(raw_g))
                                c.drawImage(
                                    imgg, cx, y_img, width=GAL_W, height=GAL_H,
                                    preserveAspectRatio=True, mask='auto',
                                )
                            except Exception:
                                c.setFillColor(MUTED)
                                c.setFont("Helvetica-Oblique", 10)
                                c.drawCentredString(cx + GAL_W / 2, y_img + GAL_H / 2,
                                                    "(imagen no legible)")
                            # Pie de foto
                            c.setFillColor(MUTED)
                            c.setFont("Helvetica", 8)
                            c.drawCentredString(
                                cx + GAL_W / 2, y_img - 0.4 * cm,
                                f"Foto {chunk_start + idx + 2} de {len(imgs)} · 13.37 × 10 cm",
                            )
                        c.showPage()
                        page_num += 1

            # =================================================================
            # NOTAS / NOTICIAS vinculadas al nodo (Importante + Urgente)
            # Se imprimen al final del bloque del nodo si existen.
            # =================================================================
            node_announ = announcements_by_node.get(n["id"]) or []
            if node_announ:
                draw_header(page_num)
                c.setFillColor(BRAND)
                c.setFont("Helvetica-Bold", 16)
                c.drawString(1.5 * cm, PH - 3.0 * cm, f"Notas y noticias · {node_path}")
                c.setStrokeColor(BRAND)
                c.setLineWidth(0.8)
                c.line(1.5 * cm, PH - 3.2 * cm, PW - 1.5 * cm, PH - 3.2 * cm)
                cy = PH - 3.9 * cm
                for ann in node_announ:
                    sev = (ann.get("jerarquia") or "informativo").lower()
                    sev_color = HexColor(_severidad_hex(sev))
                    if cy < 2.5 * cm:
                        c.showPage()
                        page_num += 1
                        draw_header(page_num)
                        cy = PH - 3.0 * cm
                    # Etiqueta de severidad
                    c.setFillColor(sev_color)
                    c.roundRect(1.5 * cm, cy - 0.45 * cm, 2.8 * cm, 0.55 * cm,
                                radius=4, stroke=0, fill=1)
                    c.setFillColor(HexColor("#FFFFFF"))
                    c.setFont("Helvetica-Bold", 8)
                    c.drawCentredString(1.5 * cm + 1.4 * cm, cy - 0.28 * cm,
                                        _severidad_label(sev).upper())
                    # Título de la nota
                    c.setFillColor(TEXT)
                    c.setFont("Helvetica-Bold", 11)
                    title_txt = (ann.get("title") or "").strip() or "—"
                    c.drawString(4.6 * cm, cy - 0.25 * cm, title_txt[:140])
                    # Fecha
                    c.setFillColor(MUTED)
                    c.setFont("Helvetica", 8)
                    c.drawRightString(PW - 1.5 * cm, cy - 0.25 * cm,
                                       _fmt_fecha_dd_mm_yyyy(ann.get("created_at")))
                    cy -= 0.8 * cm
                    # Cuerpo de la nota
                    body_txt = (ann.get("body") or "").strip()
                    if body_txt:
                        cy = render_text_block(1.5 * cm, cy, PW - 3.0 * cm,
                                               [body_txt], font="Helvetica", size=10, leading=13)
                    cy -= 0.4 * cm
                c.showPage()
                page_num += 1

        c.save()
        return buf.getvalue()

    # Render bloqueante en thread aparte → libera event loop
    pdf_bytes = await asyncio.to_thread(_build_pdf_blocking)
    fname = _safe_export_filename(proj.get("name", "proyecto"), period, "pdf")
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )



# === DOCX / PPTX EXPORT (Cero Huella Local - 100 % en RAM con BytesIO) ======
# Reglas idénticas al motor PDF (Coord = todos / Esp = propios / Sub = scope).
# Período: today | yesterday | week | month.
# Procesamiento ESTRICTAMENTE en memoria (io.BytesIO) - NO se escribe ningún
# archivo al disco del dispositivo ni del servidor.

async def _gather_export_data(
    pid: str,
    period: str,
    user: dict,
    area_id: Optional[str] = None,
    scope_mine_only: bool = False,
) -> dict:
    """Carga proyecto, nodos, reportes, anuncios y rutas aplicando filtros.

    Reglas:
      - Severidad: por instrucción institucional, las exportaciones SIEMPRE
        excluyen reportes 'informativo' (solo Importante + Urgente).
      - Área: si `area_id` viene, filtra reportes por esa área (cualquier rol).
      - Scope:
        * Coord / Sub-coord / Jefe → ven todos (a menos que pasen area_id).
        * Especialista → ve sus propios por defecto; si `scope_mine_only=False`
          y tiene `area_id`, ve los reportes del área (otros especialistas
          de su misma área también).
      - Noticias inyectables: Importante + Urgente vinculadas a cada nodo
        (o sus ancestros) dentro del periodo.
    """
    await ensure_project_access(user, pid)
    proj = await db.projects.find_one({"id": pid})
    if not proj:
        raise HTTPException(404, "Proyecto no existe")

    start_dt, end_dt, period_label = _period_range(period)

    nodes_raw = await db.location_nodes.find({"project_id": pid}).to_list(length=10000)
    nodes_by_id = {n["id"]: n for n in nodes_raw}
    root_ids = [n["id"] for n in nodes_raw if not n.get("parent_id")]
    root_ids.sort(key=lambda nid: (nodes_by_id[nid].get("order", 0), nodes_by_id[nid].get("name", "")))
    leaf_nodes = _flatten_tree_in_order(nodes_by_id, root_ids)

    role = user["role"]
    sev_filter = _export_severity_filter(role)

    # --- Construir query base con filtros institucionales ---
    q: dict = {
        "project_id": pid,
        "created_at": {"$gte": start_dt, "$lte": end_dt},
        # Severidad filter (solo Importante + Urgente). Si el documento legacy
        # no tenía severidad, se considera 'informativo' y queda EXCLUIDO.
        "severidad": {"$in": list(sev_filter)},
    }

    # Scope
    if role == ROLE_ESPECIALISTA:
        # Especialista: por defecto solo sus propios reportes.
        # Si `scope_mine_only=False` y tiene area_id, ampliamos al área.
        my_area = user.get("area_id")
        if scope_mine_only or not my_area:
            q["captured_by"] = user["id"]
        else:
            q["area_id"] = my_area
    else:
        # Supervisor (sub/jefe/coord): ven todo, opcionalmente filtrado por área.
        if area_id:
            q["area_id"] = area_id

    # Filtro área explícito (cuando coordinador/sub pasa area_id sin importar
    # el rol — ya manejado arriba para supervisores; para especialista lo
    # tomamos en cuenta también si pasa area_id explícito y no scope_mine_only).
    if role == ROLE_ESPECIALISTA and area_id and not scope_mine_only:
        q["area_id"] = area_id

    reports = await db.reports.find(q).to_list(length=20000)
    reports_by_node: dict = {}
    for r in reports:
        reports_by_node.setdefault(r.get("node_id"), []).append(r)
    for nid, lst in reports_by_node.items():
        lst.sort(key=lambda r: r.get("created_at") or datetime.min)

    path_cache: dict = {}
    for nid in list(reports_by_node.keys()):
        names = await node_path_names(nid)
        path_cache[nid] = " › ".join(names)

    # --- Noticias por nodo (Importante+Urgente, vinculadas a nodo o ancestros)
    announcements_by_node: dict = {}
    for nid in list(reports_by_node.keys()):
        node = nodes_by_id.get(nid)
        if not node:
            continue
        # build_node_path devuelve [root, ..., leaf] usando parent_id (path en BD
        # puede no estar materializado).
        path_ids = await build_node_path(node)
        if nid not in path_ids:
            path_ids.append(nid)
        announcements_by_node[nid] = await _announcements_for_node(pid, path_ids, start_dt, end_dt)

    # --- Primera lectura previa por nodo (continuidad histórica) ---
    prev_reading_by_node: dict = {}
    for nid in reports_by_node.keys():
        pre_q: dict = {"project_id": pid, "node_id": nid, "created_at": {"$lt": start_dt}}
        if role == ROLE_ESPECIALISTA and scope_mine_only:
            pre_q["captured_by"] = user["id"]
        prev = await db.reports.find(pre_q).sort("created_at", -1).limit(1).to_list(length=1)
        prev_reading_by_node[nid] = _extract_numeric_reading(prev[0]) if prev else None

    return {
        "proj": proj,
        "leaf_nodes": leaf_nodes,
        "reports_by_node": reports_by_node,
        "announcements_by_node": announcements_by_node,
        "path_cache": path_cache,
        "period_label": period_label,
        "start_dt": start_dt,
        "end_dt": end_dt,
        "prev_reading_by_node": prev_reading_by_node,
        "user": user,
    }


def _safe_export_filename(name: str, period: str, ext: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]+", "_", name or "proyecto")[:60] or "proyecto"
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M")
    # Sin prefijo "synco_": el archivo debe ser 100% institucional.
    return f"reporte_{safe}_{period}_{ts}.{ext}"


@api.get("/projects/{pid}/export/reports.docx")
async def export_reports_docx(
    pid: str,
    period: str = Query("today", description="today|yesterday|week|month"),
    area_id: Optional[str] = Query(None, description="Filtro por área (opcional)"),
    scope: Optional[str] = Query(None, description="mine|area (para especialistas)"),
    user: dict = Depends(current_user),
):
    """Exporta reportes en formato Microsoft Word (.docx). 100 % en RAM.

    Filtros idénticos al PDF: severidad (Importante+Urgente), área opcional,
    y scope para especialistas."""
    try:
        import base64
        from docx import Document
        from docx.shared import Cm, Pt, RGBColor
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        from docx.oxml.ns import qn
        from docx.oxml import OxmlElement
    except Exception as e:
        raise HTTPException(500, f"python-docx no instalado: {e}")

    scope_mine_only = (scope or "").lower() == "mine"
    data = await _gather_export_data(pid, period, user, area_id=area_id, scope_mine_only=scope_mine_only)
    proj = data["proj"]
    leaf_nodes = data["leaf_nodes"]
    reports_by_node = data["reports_by_node"]
    announcements_by_node = data["announcements_by_node"]
    path_cache = data["path_cache"]
    start_dt = data["start_dt"]
    end_dt = data["end_dt"]

    project_name = proj.get("name", "Proyecto")
    project_contract = proj.get("contract_number") or "—"
    project_constructora = proj.get("constructora") or "—"
    project_objeto = proj.get("objeto_contrato") or None
    project_cliente = (proj.get("cliente_principal") or "").strip() or None
    project_color = _sanitize_color_hex(proj.get("color_tema")) or "#003366"
    constructora_logo_b64 = (proj.get("constructora_logo") or "").strip() or None
    fechas_label = f"{_fmt_fecha_dd_mm_yyyy(start_dt)} a {_fmt_fecha_dd_mm_yyyy(end_dt)}"

    area_label = "Todas las áreas"
    if area_id:
        area = await db.areas.find_one({"id": area_id, "project_id": pid})
        if area:
            area_label = f"Área: {area.get('name', '—')}"

    def _build_docx_blocking() -> bytes:
        # Resuelve logo institucional UNA sola vez (proyecto → DIRAC fallback)
        logo_bytes = _resolve_export_logo_bytes(constructora_logo_b64)

        # Color institucional del proyecto (hex → RGB)
        _ch = (project_color or "#003366").lstrip("#")
        BRAND_RGB = RGBColor(int(_ch[0:2], 16), int(_ch[2:4], 16), int(_ch[4:6], 16))
        TEXT_RGB = RGBColor(0x0F, 0x17, 0x2A)
        MUTED_RGB = RGBColor(0x64, 0x75, 0x8B)

        def _shade_cell(cell, hex_color: str):
            """Pinta el fondo de una celda Word con el hex dado."""
            try:
                tc_pr = cell._tc.get_or_add_tcPr()
                shd = OxmlElement('w:shd')
                shd.set(qn('w:val'), 'clear')
                shd.set(qn('w:color'), 'auto')
                shd.set(qn('w:fill'), hex_color.lstrip('#'))
                tc_pr.append(shd)
            except Exception:
                pass

        doc = Document()
        for section in doc.sections:
            section.left_margin = Cm(1.8)
            section.right_margin = Cm(1.8)
            section.top_margin = Cm(2.2)
            section.bottom_margin = Cm(2.0)
            # Encabezado institucional
            header = section.header
            hp = header.paragraphs[0]
            hp.alignment = WD_ALIGN_PARAGRAPH.LEFT
            if logo_bytes:
                try:
                    hp.add_run().add_picture(io.BytesIO(logo_bytes), height=Cm(1.2))
                except Exception:
                    pass
            hp.add_run(f"   {project_constructora}   ·   Contrato {project_contract}").font.size = Pt(9)
            # Pie de página institucional
            footer = section.footer
            fp = footer.paragraphs[0]
            fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
            fr = fp.add_run(f"{project_name}   ·   Exportado {_fmt_fecha_dd_mm_yyyy_hhmm(datetime.now(timezone.utc))}")
            fr.font.size = Pt(8)
            fr.font.color.rgb = MUTED_RGB

        # === PORTADA INSTITUCIONAL ===
        # Word no permite color de fondo en página directamente; usamos una tabla
        # de 1x1 a ancho completo con shading en color_tema y texto blanco.
        portada_tbl = doc.add_table(rows=1, cols=1)
        portada_tbl.autofit = False
        portada_cell = portada_tbl.rows[0].cells[0]
        # Ancho ~ 17 cm (A4 - márgenes)
        portada_cell.width = Cm(17)
        _shade_cell(portada_cell, project_color)
        # Limpiar primer párrafo (default) y construir contenido
        portada_cell.paragraphs[0].clear() if False else None  # mantener referencia
        # Logo + cliente
        if logo_bytes:
            try:
                logo_p = portada_cell.paragraphs[0]
                logo_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                logo_p.add_run().add_picture(io.BytesIO(logo_bytes), width=Cm(5.5))
            except Exception:
                pass
        if project_cliente:
            cli_p = portada_cell.add_paragraph()
            cli_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            cli_r = cli_p.add_run(project_cliente)
            cli_r.bold = True
            cli_r.font.size = Pt(14)
            cli_r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        # Encabezado del informe
        inf_p = portada_cell.add_paragraph()
        inf_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        inf_r = inf_p.add_run("INFORME DE AVANCE Y SUPERVISIÓN")
        inf_r.bold = True
        inf_r.font.size = Pt(11)
        inf_r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        # Nombre del proyecto
        np_p = portada_cell.add_paragraph()
        np_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        np_r = np_p.add_run(project_name)
        np_r.bold = True
        np_r.font.size = Pt(26)
        np_r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        # Objeto del contrato (cursiva blanca)
        if project_objeto:
            obj_p = portada_cell.add_paragraph()
            obj_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            obj_r = obj_p.add_run(project_objeto)
            obj_r.italic = True
            obj_r.font.size = Pt(12)
            obj_r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        # Separador
        portada_cell.add_paragraph()
        # Pie portada: contrato + período + área
        info_p = portada_cell.add_paragraph()
        info_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        info_r = info_p.add_run(
            f"Contrato: {project_contract}   ·   Período: {fechas_label}\n{area_label}"
        )
        info_r.font.size = Pt(11)
        info_r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)

        any_data = False

        for n in leaf_nodes:
            node_reps = reports_by_node.get(n["id"]) or []
            if not node_reps:
                continue
            any_data = True
            node_path = path_cache.get(n["id"]) or n.get("name", "")

            # Separador por nodo
            doc.add_page_break()
            np = doc.add_paragraph()
            np.alignment = WD_ALIGN_PARAGRAPH.CENTER
            nr = np.add_run(node_path)
            nr.bold = True
            nr.font.size = Pt(18)
            nr.font.color.rgb = BRAND_RGB

            try:
                coord_text = _format_measurement_for_display(node_reps[0]) or "—"
            except Exception:
                coord_text = "—"
            cp = doc.add_paragraph()
            cp.alignment = WD_ALIGN_PARAGRAPH.CENTER
            cr = cp.add_run(f"Coordenadas: {coord_text}")
            cr.font.size = Pt(12)
            cr.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)

            cnt = doc.add_paragraph()
            cnt.alignment = WD_ALIGN_PARAGRAPH.CENTER
            cntr = cnt.add_run(f"Reportes en este nodo: {len(node_reps)}")
            cntr.font.size = Pt(10)
            cntr.font.color.rgb = RGBColor(0x64, 0x75, 0x8B)

            for r in node_reps:
                doc.add_page_break()

                # Recopilar imágenes para usarlas DESPUÉS del texto.
                imgs = r.get("images") or []
                img_b64 = _strip_b64_prefix(imgs[0]) if imgs else None

                # Datos
                def _raw_to_str(v):
                    if v is None or v == "":
                        return "—"
                    try:
                        return _fmt_reading(float(v))
                    except Exception:
                        return str(v).strip() or "—"

                primera_str = _raw_to_str(r.get("primera_lectura"))
                ultima_str = _raw_to_str(r.get("ultima_lectura"))
                _av = r.get("avance")
                avance_str = str(_av).strip() if _av not in (None, "") else "—"
                ts = r.get("created_at")
                fecha_str = _fmt_fecha_dd_mm_yyyy(ts) if isinstance(ts, datetime) else "—"
                nombre = r.get("captured_by_name") or "—"
                contratista_rep = (project_constructora or "—").strip()
                unidad_r = (r.get("unidad") or "m").strip() or "m"
                personal_list = [p for p in (r.get("personnel") or []) if p]
                equipo_list = [e for e in (r.get("equipment") or []) if e]
                personal_str = ", ".join(personal_list) if personal_list else "N/A"
                equipo_str = ", ".join(equipo_list) if equipo_list else "N/A"
                obs_str = (r.get("observaciones") or r.get("notes") or "").strip() or "N/A"
                incidencias_str = (r.get("incidencias") or "").strip() or None
                sev = (r.get("severidad") or "informativo").lower()
                sev_label = _severidad_label(sev).upper()

                # Banner de severidad
                sev_p = doc.add_paragraph()
                sev_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                sev_r = sev_p.add_run(f"[ {sev_label} ]")
                sev_r.bold = True
                sev_r.font.size = Pt(11)
                hexc = _severidad_hex(sev).lstrip("#")
                sev_r.font.color.rgb = RGBColor(int(hexc[0:2], 16), int(hexc[2:4], 16), int(hexc[4:6], 16))

                table = doc.add_table(rows=0, cols=2)
                table.autofit = True

                def _row(label: str, value: str):
                    row = table.add_row().cells
                    # Etiqueta: fondo color_tema, texto blanco
                    _shade_cell(row[0], project_color)
                    pl = row[0].paragraphs[0]
                    plr = pl.add_run(label.upper())
                    plr.bold = True
                    plr.font.size = Pt(9)
                    plr.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
                    pv = row[1].paragraphs[0]
                    pvr = pv.add_run(str(value))
                    pvr.font.size = Pt(10)
                    pvr.font.color.rgb = TEXT_RGB

                # === Orden institucional ===
                _row("Fecha", fecha_str)
                _row("Especialista", nombre)
                _row("Constructora", contratista_rep)
                _row("No. de Contrato", project_contract)
                _row("Nodo / Ubicación", node_path)
                _row("Reporte de avance",
                     f"Primera: {primera_str} {unidad_r}  |  Última: {ultima_str} {unidad_r}  |  Avance: {avance_str}")
                # Situación social (incidencias o "Sin incidencias")
                _row("Situación social",
                     incidencias_str if incidencias_str else "Sin incidencias.")
                # Actividades (observaciones + métricas)
                _actividades = []
                if obs_str and obs_str != "N/A":
                    _actividades.append(obs_str)
                _actividades.append(
                    f"Métricas — Primera lectura: {primera_str} {unidad_r} · "
                    f"Última lectura: {ultima_str} {unidad_r} · Avance: {avance_str}."
                )
                _row("Actividades", " ".join(_actividades))
                _row("Personal", personal_str)
                _row("Equipo", equipo_str)

                # === Foto principal — DESPUÉS del texto (institucional) ===
                if img_b64:
                    try:
                        raw = base64.b64decode(img_b64)
                        img_buf = io.BytesIO(raw)
                        img_p = doc.add_paragraph()
                        img_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                        # Tamaño institucional: 13.37 cm de ancho × 10 cm de alto
                        img_p.add_run().add_picture(img_buf, width=Cm(13.37), height=Cm(10.0))
                        cap = doc.add_paragraph()
                        cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
                        cap_r = cap.add_run(
                            f"Foto 1 de {len(imgs)} · 13.37 × 10 cm"
                            if len(imgs) > 1 else "13.37 × 10 cm"
                        )
                        cap_r.italic = True
                        cap_r.font.size = Pt(8)
                        cap_r.font.color.rgb = MUTED_RGB
                    except Exception:
                        p = doc.add_paragraph()
                        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                        rr = p.add_run("(imagen no legible)")
                        rr.italic = True
                        rr.font.color.rgb = RGBColor(0x64, 0x75, 0x8B)
                else:
                    p = doc.add_paragraph()
                    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    rr = p.add_run("(sin fotografía)")
                    rr.italic = True
                    rr.font.color.rgb = RGBColor(0x64, 0x75, 0x8B)

                # === Galería de fotos adicionales — 2 por página, 13.37×10 cm ===
                extra_imgs = imgs[1:] if len(imgs) > 1 else []
                if extra_imgs:
                    doc.add_page_break()
                    gh = doc.add_paragraph()
                    gh.alignment = WD_ALIGN_PARAGRAPH.LEFT
                    gh_r = gh.add_run(f"Fotografías adicionales ({len(extra_imgs)})")
                    gh_r.bold = True
                    gh_r.font.size = Pt(13)
                    gh_r.font.color.rgb = BRAND_RGB
                    # 2 fotos por página → cada par en su propio bloque + page break
                    for chunk_start in range(0, len(extra_imgs), 2):
                        chunk = extra_imgs[chunk_start:chunk_start + 2]
                        for off, b64 in enumerate(chunk):
                            try:
                                raw_ex = base64.b64decode(_strip_b64_prefix(b64))
                                ip = doc.add_paragraph()
                                ip.alignment = WD_ALIGN_PARAGRAPH.CENTER
                                ip.add_run().add_picture(
                                    io.BytesIO(raw_ex),
                                    width=Cm(13.37), height=Cm(10.0),
                                )
                                cap = doc.add_paragraph()
                                cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
                                cap_r = cap.add_run(
                                    f"Foto {chunk_start + off + 2} de {len(imgs)} · 13.37 × 10 cm"
                                )
                                cap_r.italic = True
                                cap_r.font.size = Pt(8)
                                cap_r.font.color.rgb = MUTED_RGB
                            except Exception:
                                err = doc.add_paragraph()
                                err.alignment = WD_ALIGN_PARAGRAPH.CENTER
                                er = err.add_run(f"(Foto {chunk_start + off + 2} no legible)")
                                er.italic = True
                                er.font.color.rgb = MUTED_RGB
                        # Salto de página después de cada par (excepto el último)
                        if chunk_start + 2 < len(extra_imgs):
                            doc.add_page_break()

            # === Sección "Notas/Noticias" del nodo (Importante+Urgente) ===
            node_announ = announcements_by_node.get(n["id"]) or []
            if node_announ:
                doc.add_page_break()
                head = doc.add_paragraph()
                head.alignment = WD_ALIGN_PARAGRAPH.LEFT
                hr = head.add_run(f"Notas y noticias · {node_path}")
                hr.bold = True
                hr.font.size = Pt(16)
                hr.font.color.rgb = BRAND_RGB
                for ann in node_announ:
                    sev_a = (ann.get("jerarquia") or "informativo").lower()
                    hexa = _severidad_hex(sev_a).lstrip("#")
                    note_p = doc.add_paragraph()
                    note_p.alignment = WD_ALIGN_PARAGRAPH.LEFT
                    note_label = note_p.add_run(f"[ {_severidad_label(sev_a).upper()} ]   ")
                    note_label.bold = True
                    note_label.font.size = Pt(10)
                    note_label.font.color.rgb = RGBColor(int(hexa[0:2], 16), int(hexa[2:4], 16), int(hexa[4:6], 16))
                    title_r = note_p.add_run((ann.get("title") or "—").strip())
                    title_r.bold = True
                    title_r.font.size = Pt(11)
                    title_r.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)
                    date_r = note_p.add_run(f"    ({_fmt_fecha_dd_mm_yyyy(ann.get('created_at'))})")
                    date_r.italic = True
                    date_r.font.size = Pt(9)
                    date_r.font.color.rgb = RGBColor(0x64, 0x75, 0x8B)
                    body_p = doc.add_paragraph()
                    br = body_p.add_run((ann.get("body") or "").strip())
                    br.font.size = Pt(10)
                    br.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)

        if not any_data:
            empty = doc.add_paragraph()
            empty.alignment = WD_ALIGN_PARAGRAPH.CENTER
            er = empty.add_run("Sin reportes en el período seleccionado.")
            er.italic = True
            er.font.size = Pt(12)
            er.font.color.rgb = RGBColor(0x64, 0x75, 0x8B)

        buf = io.BytesIO()
        doc.save(buf)
        return buf.getvalue()

    docx_bytes = await asyncio.to_thread(_build_docx_blocking)
    fname = _safe_export_filename(project_name, period, "docx")
    return StreamingResponse(
        io.BytesIO(docx_bytes),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@api.get("/projects/{pid}/export/reports.pptx")
async def export_reports_pptx(
    pid: str,
    period: str = Query("today", description="today|yesterday|week|month"),
    area_id: Optional[str] = Query(None, description="Filtro por área (opcional)"),
    scope: Optional[str] = Query(None, description="mine|area (para especialistas)"),
    user: dict = Depends(current_user),
):
    """Exporta reportes en formato PowerPoint (.pptx) 100 % institucional.

    - SIN branding 'SynCo'.
    - Logo de la constructora si está disponible (alta resolución).
    - Filtros: severidad por rol, área opcional, scope para especialistas.
    - Inyecta noticias Importante/Urgente por nodo al final de su sección.
    - Reordena los campos siguiendo el orden institucional (igual a PDF/DOCX).
    - Fechas en zona horaria 'America/Mexico_City' (DD-MM-YYYY).
    """
    try:
        import base64
        from pptx import Presentation
        from pptx.util import Cm, Pt, Emu
        from pptx.dml.color import RGBColor as PRGBColor
        from pptx.enum.text import PP_ALIGN
    except Exception as e:
        raise HTTPException(500, f"python-pptx no instalado: {e}")

    scope_mine_only = (scope or "").lower() == "mine"
    data = await _gather_export_data(
        pid, period, user, area_id=area_id, scope_mine_only=scope_mine_only,
    )
    proj = data["proj"]
    leaf_nodes = data["leaf_nodes"]
    reports_by_node = data["reports_by_node"]
    announcements_by_node = data["announcements_by_node"]
    path_cache = data["path_cache"]
    start_dt = data["start_dt"]
    end_dt = data["end_dt"]

    project_name = proj.get("name", "Proyecto")
    project_contract = proj.get("contract_number") or "—"
    project_constructora = proj.get("constructora") or "—"
    project_objeto = (proj.get("objeto_contrato") or "").strip() or None
    project_cliente = (proj.get("cliente_principal") or "").strip() or None
    project_color = _sanitize_color_hex(proj.get("color_tema")) or "#003366"
    _ch = project_color.lstrip("#")
    BRAND_RGB = (int(_ch[0:2], 16), int(_ch[2:4], 16), int(_ch[4:6], 16))
    constructora_logo_b64 = (proj.get("constructora_logo") or "").strip() or None
    fechas_label = f"{_fmt_fecha_dd_mm_yyyy(start_dt)} a {_fmt_fecha_dd_mm_yyyy(end_dt)}"

    area_label = "Todas las áreas"
    if area_id:
        area = await db.areas.find_one({"id": area_id, "project_id": pid})
        if area:
            area_label = f"Área: {area.get('name', '—')}"

    def _build_pptx_blocking() -> bytes:
        prs = Presentation()
        # A4 apaisado para que quepan 2 fotos lado a lado (13.37 × 2 + márgenes < 29.7)
        prs.slide_width = Cm(29.7)
        prs.slide_height = Cm(21.0)
        SW, SH = prs.slide_width, prs.slide_height
        blank = prs.slide_layouts[6]

        # Imports adicionales para shape fill
        from pptx.enum.shapes import MSO_SHAPE
        from pptx.oxml.ns import qn as _qn
        from lxml import etree as _ET

        def add_bg_rect(slide, x, y, w, h, rgb_tuple):
            """Pinta un rectángulo de fondo con color sólido (sin borde)."""
            sh = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, w, h)
            sh.fill.solid()
            sh.fill.fore_color.rgb = PRGBColor(*rgb_tuple)
            sh.line.fill.background()
            try:
                sh.shadow.inherit = False
            except Exception:
                pass
            return sh

        def add_text(slide, x, y, w, h, text, *, size=14, bold=False, color=(0x0F, 0x17, 0x2A),
                     align=PP_ALIGN.LEFT, italic=False):
            tb = slide.shapes.add_textbox(x, y, w, h)
            tf = tb.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            p.alignment = align
            run = p.add_run()
            run.text = str(text)
            run.font.size = Pt(size)
            run.font.bold = bold
            run.font.italic = italic
            run.font.color.rgb = PRGBColor(*color)
            return tb

        # Logo institucional (proyecto o DIRAC). Una sola descarga.
        logo_bytes = _resolve_export_logo_bytes(constructora_logo_b64)

        def add_logo(slide, x, y, w_cm: float, h_cm: float):
            if not logo_bytes:
                return False
            try:
                slide.shapes.add_picture(
                    io.BytesIO(logo_bytes), x, y,
                    width=Cm(w_cm), height=Cm(h_cm),
                )
                return True
            except Exception:
                return False

        def add_header_footer(slide):
            """Encabezado institucional + pie. Color dinámico."""
            # Banda superior con color_tema
            add_bg_rect(slide, 0, 0, SW, Cm(1.5), BRAND_RGB)
            if logo_bytes:
                try:
                    slide.shapes.add_picture(
                        io.BytesIO(logo_bytes), Cm(0.6), Cm(0.25),
                        height=Cm(1.0),
                    )
                except Exception:
                    pass
            add_text(slide, Cm(3.5), Cm(0.4), SW - Cm(4.5), Cm(0.8),
                     f"{project_constructora}   ·   Contrato {project_contract}",
                     size=11, bold=True, color=(0xFF, 0xFF, 0xFF))
            # Footer institucional
            export_stamp = _fmt_fecha_dd_mm_yyyy_hhmm(datetime.now(timezone.utc))
            add_text(slide, Cm(1.0), SH - Cm(0.8), SW - Cm(2.0), Cm(0.5),
                     f"{project_name}   ·   Exportado {export_stamp}",
                     size=8, italic=True, color=(0x64, 0x75, 0x8B),
                     align=PP_ALIGN.CENTER)

        # ===== PORTADA INSTITUCIONAL =====
        s = prs.slides.add_slide(blank)
        # Fondo completo en color_tema
        add_bg_rect(s, 0, 0, SW, SH, BRAND_RGB)
        # Banda blanca translúcida superior con logo
        add_bg_rect(s, 0, 0, SW, Cm(4.0), (255, 255, 255))
        if logo_bytes:
            try:
                s.shapes.add_picture(io.BytesIO(logo_bytes), Cm(1.0), Cm(0.6), height=Cm(2.6))
            except Exception:
                pass
        # Cliente principal arriba a la derecha
        if project_cliente:
            add_text(s, Cm(15.0), Cm(1.0), Cm(13.7), Cm(1.0),
                     "CLIENTE", size=10, bold=True, color=BRAND_RGB,
                     align=PP_ALIGN.RIGHT)
            add_text(s, Cm(15.0), Cm(1.8), Cm(13.7), Cm(1.5),
                     project_cliente[:80], size=18, bold=True,
                     color=(0x0F, 0x17, 0x2A), align=PP_ALIGN.RIGHT)
        # Título central
        add_text(s, Cm(1.0), Cm(6.0), SW - Cm(2.0), Cm(1.0),
                 "INFORME DE AVANCE Y SUPERVISIÓN",
                 size=14, bold=True, color=(0xFF, 0xFF, 0xFF), align=PP_ALIGN.CENTER)
        add_text(s, Cm(1.0), Cm(7.5), SW - Cm(2.0), Cm(3.0),
                 project_name,
                 size=44, bold=True, color=(0xFF, 0xFF, 0xFF), align=PP_ALIGN.CENTER)
        if project_objeto:
            add_text(s, Cm(2.5), Cm(11.0), SW - Cm(5.0), Cm(3.5),
                     project_objeto,
                     size=16, italic=True, color=(0xFF, 0xFF, 0xFF), align=PP_ALIGN.CENTER)
        # Pie portada: contrato + período + área
        add_text(s, Cm(1.0), SH - Cm(3.5), Cm(10.0), Cm(0.8),
                 "PERÍODO", size=10, bold=True, color=(0xFF, 0xFF, 0xFF))
        add_text(s, Cm(1.0), SH - Cm(2.8), Cm(10.0), Cm(0.8),
                 fechas_label, size=12, color=(0xFF, 0xFF, 0xFF))
        add_text(s, Cm(11.5), SH - Cm(3.5), Cm(8.0), Cm(0.8),
                 "CONSTRUCTORA", size=10, bold=True, color=(0xFF, 0xFF, 0xFF),
                 align=PP_ALIGN.CENTER)
        add_text(s, Cm(11.5), SH - Cm(2.8), Cm(8.0), Cm(0.8),
                 project_constructora, size=12, color=(0xFF, 0xFF, 0xFF),
                 align=PP_ALIGN.CENTER)
        add_text(s, SW - Cm(11.0), SH - Cm(3.5), Cm(10.0), Cm(0.8),
                 "CONTRATO", size=10, bold=True, color=(0xFF, 0xFF, 0xFF),
                 align=PP_ALIGN.RIGHT)
        add_text(s, SW - Cm(11.0), SH - Cm(2.8), Cm(10.0), Cm(0.8),
                 project_contract, size=12, color=(0xFF, 0xFF, 0xFF),
                 align=PP_ALIGN.RIGHT)
        add_text(s, Cm(1.0), SH - Cm(1.4), SW - Cm(2.0), Cm(0.7),
                 f"{area_label}   ·   {_fmt_fecha_dd_mm_yyyy_hhmm(datetime.now(timezone.utc))}",
                 size=10, italic=True, color=(0xFF, 0xFF, 0xFF),
                 align=PP_ALIGN.CENTER)

        any_data = False
        for n in leaf_nodes:
            node_reps = reports_by_node.get(n["id"]) or []
            if not node_reps:
                continue
            any_data = True
            node_path = path_cache.get(n["id"]) or n.get("name", "")

            # === Slide separador por nodo ===
            s = prs.slides.add_slide(blank)
            add_header_footer(s)
            add_text(s, Cm(1.5), Cm(6.0), SW - Cm(3.0), Cm(2.5),
                     node_path, size=36, bold=True, color=BRAND_RGB,
                     align=PP_ALIGN.CENTER)
            try:
                coord_text = _format_measurement_for_display(node_reps[0]) or "—"
            except Exception:
                coord_text = "—"
            add_text(s, Cm(1.5), Cm(10.5), SW - Cm(3.0), Cm(1.0),
                     f"Coordenadas: {coord_text}",
                     size=16, color=(0x0F, 0x17, 0x2A), align=PP_ALIGN.CENTER)
            add_text(s, Cm(1.5), Cm(12.0), SW - Cm(3.0), Cm(1.0),
                     f"Reportes en este nodo: {len(node_reps)}",
                     size=12, color=(0x64, 0x75, 0x8B), align=PP_ALIGN.CENTER)

            for r in node_reps:
                slide = prs.slides.add_slide(blank)
                add_header_footer(slide)

                # Foto principal con tamaño exacto 13.37 cm × 10 cm
                photo_x = Cm(1.0)
                photo_y = Cm(2.2)
                photo_w = Cm(13.37)
                photo_h = Cm(10.0)
                img_b64 = None
                imgs = r.get("images") or []
                if imgs:
                    img_b64 = _strip_b64_prefix(imgs[0])
                if img_b64:
                    try:
                        raw = base64.b64decode(img_b64)
                        img_buf = io.BytesIO(raw)
                        slide.shapes.add_picture(img_buf, photo_x, photo_y,
                                                 width=photo_w, height=photo_h)
                    except Exception:
                        add_text(slide, photo_x, photo_y + Cm(4.5), photo_w, Cm(1.0),
                                 "(imagen no legible)", size=11,
                                 color=(0x64, 0x75, 0x8B), italic=True,
                                 align=PP_ALIGN.CENTER)
                else:
                    add_text(slide, photo_x, photo_y + Cm(4.5), photo_w, Cm(1.0),
                             "(sin fotografía)", size=11,
                             color=(0x64, 0x75, 0x8B), italic=True,
                             align=PP_ALIGN.CENTER)

                # Pie de foto principal
                add_text(
                    slide, photo_x, photo_y + photo_h + Cm(0.15), photo_w, Cm(0.5),
                    f"Foto 1 de {len(imgs)} · 13.37 × 10 cm" if len(imgs) > 1
                    else "13.37 × 10 cm",
                    size=9, italic=True, color=(0x64, 0x75, 0x8B),
                    align=PP_ALIGN.CENTER,
                )

                # Datos derecha
                def _raw_to_str(v):
                    if v is None or v == "":
                        return "—"
                    try:
                        return _fmt_reading(float(v))
                    except Exception:
                        return str(v).strip() or "—"

                primera_str = _raw_to_str(r.get("primera_lectura"))
                ultima_str = _raw_to_str(r.get("ultima_lectura"))
                _av = r.get("avance")
                avance_str = str(_av).strip() if _av not in (None, "") else "—"
                ts = r.get("created_at")
                fecha_str = _fmt_fecha_dd_mm_yyyy(ts) if isinstance(ts, datetime) else "—"
                nombre = r.get("captured_by_name") or "—"
                contratista_rep = (project_constructora or "—").strip()
                unidad_r = (r.get("unidad") or "m").strip() or "m"
                personal_list = [p for p in (r.get("personnel") or []) if p]
                equipo_list = [e for e in (r.get("equipment") or []) if e]
                personal_str = ", ".join(personal_list) if personal_list else "N/A"
                equipo_str = ", ".join(equipo_list) if equipo_list else "N/A"
                obs_str = (r.get("observaciones") or r.get("notes") or "").strip() or "N/A"
                incidencias_str = (r.get("incidencias") or "").strip() or None
                sev = (r.get("severidad") or "informativo").lower()
                sev_label = _severidad_label(sev).upper()
                hexc = _severidad_hex(sev).lstrip("#")
                sev_color = (int(hexc[0:2], 16), int(hexc[2:4], 16), int(hexc[4:6], 16))

                data_x = Cm(15.0)
                data_y = Cm(2.2)
                data_w = SW - data_x - Cm(1.0)

                # Banner de severidad arriba de la tabla de datos
                add_text(slide, data_x, data_y, data_w, Cm(0.7),
                         f"[ {sev_label} ]", size=12, bold=True,
                         color=sev_color, align=PP_ALIGN.LEFT)

                # Filas institucionales (Situación social + Actividades)
                _act_lines = []
                if obs_str and obs_str != "N/A":
                    _act_lines.append(obs_str)
                _act_lines.append(
                    f"Métricas — Primera: {primera_str} {unidad_r} · "
                    f"Última: {ultima_str} {unidad_r} · Avance: {avance_str}."
                )
                _actividades = " ".join(_act_lines)
                rows = [
                    ("Fecha", fecha_str),
                    ("Especialista", nombre),
                    ("Constructora", contratista_rep),
                    ("No. de Contrato", project_contract),
                    ("Nodo / Ubicación", node_path),
                    ("Reporte de avance",
                     f"Primera: {primera_str} {unidad_r}  |  Última: {ultima_str} {unidad_r}  |  Avance: {avance_str}"),
                    ("Situación social",
                     incidencias_str if incidencias_str else "Sin incidencias."),
                    ("Actividades",
                     _actividades[:380] + ("…" if len(_actividades) > 380 else "")),
                    ("Personal", personal_str),
                    ("Equipo", equipo_str),
                ]

                tb = slide.shapes.add_textbox(data_x, data_y + Cm(0.8), data_w, Cm(17.0))
                tf = tb.text_frame
                tf.word_wrap = True
                first = True
                for lbl, val in rows:
                    p_lbl = tf.paragraphs[0] if first else tf.add_paragraph()
                    p_lbl.alignment = PP_ALIGN.LEFT
                    r_lbl = p_lbl.add_run()
                    r_lbl.text = lbl.upper()
                    r_lbl.font.size = Pt(9)
                    r_lbl.font.bold = True
                    r_lbl.font.color.rgb = PRGBColor(*BRAND_RGB)
                    p_val = tf.add_paragraph()
                    p_val.alignment = PP_ALIGN.LEFT
                    r_val = p_val.add_run()
                    r_val.text = str(val)
                    r_val.font.size = Pt(10)
                    r_val.font.color.rgb = PRGBColor(0x0F, 0x17, 0x2A)
                    first = False

                # === Slides de "Fotografías adicionales" (2 por slide, 13.37×10) ===
                if len(imgs) > 1:
                    PER_PAGE = 2
                    cell_w = Cm(13.37)
                    cell_h = Cm(10.0)
                    gap_x = Cm(0.6)
                    total_w = PER_PAGE * cell_w + (PER_PAGE - 1) * gap_x
                    margin_x = (SW - total_w) // 2
                    # Centrado vertical entre header (1.5) y footer (0.8) ≈ área (1.8..20.2)
                    margin_y = (SH - cell_h) // 2 + Cm(0.5)
                    extras = imgs[1:]
                    total_pages = (len(extras) + PER_PAGE - 1) // PER_PAGE
                    for chunk_idx in range(total_pages):
                        chunk = extras[chunk_idx * PER_PAGE:(chunk_idx + 1) * PER_PAGE]
                        g_slide = prs.slides.add_slide(blank)
                        add_header_footer(g_slide)
                        add_text(
                            g_slide, Cm(1.0), Cm(1.8), SW - Cm(2.0), Cm(0.8),
                            f"Fotografías adicionales · {node_path[:60]}  ·  "
                            f"Página {chunk_idx + 1} de {total_pages}",
                            size=16, bold=True, color=BRAND_RGB,
                            align=PP_ALIGN.LEFT,
                        )
                        for idx, b64 in enumerate(chunk):
                            cx = margin_x + idx * (cell_w + gap_x)
                            cyy = margin_y
                            try:
                                raw_g = base64.b64decode(_strip_b64_prefix(b64))
                                g_slide.shapes.add_picture(
                                    io.BytesIO(raw_g), cx, cyy,
                                    width=cell_w, height=cell_h,
                                )
                            except Exception:
                                add_text(
                                    g_slide, cx, cyy + cell_h / 2, cell_w, Cm(0.6),
                                    "(imagen no legible)",
                                    size=10, italic=True, color=(0x64, 0x75, 0x8B),
                                    align=PP_ALIGN.CENTER,
                                )
                            add_text(
                                g_slide, cx, cyy + cell_h + Cm(0.15), cell_w, Cm(0.4),
                                f"Foto {chunk_idx * PER_PAGE + idx + 2} de {len(imgs)} · 13.37 × 10 cm",
                                size=8, italic=True, color=(0x64, 0x75, 0x8B),
                                align=PP_ALIGN.CENTER,
                            )

            # === Slide(s) de Notas/Noticias vinculadas al nodo ===
            node_announ = announcements_by_node.get(n["id"]) or []
            if node_announ:
                an_slide = prs.slides.add_slide(blank)
                add_header_footer(an_slide)
                add_text(an_slide, Cm(1.0), Cm(1.4), SW - Cm(2.0), Cm(1.2),
                         f"Notas y noticias · {node_path}",
                         size=22, bold=True, color=BRAND_RGB,
                         align=PP_ALIGN.LEFT)
                cur_y = Cm(3.0)
                for ann in node_announ:
                    if cur_y > Cm(12.5):
                        # Nuevo slide si se llena el espacio
                        an_slide = prs.slides.add_slide(blank)
                        add_header_footer(an_slide)
                        add_text(an_slide, Cm(1.0), Cm(1.4), SW - Cm(2.0), Cm(1.2),
                                 f"Notas y noticias · {node_path} (cont.)",
                                 size=22, bold=True, color=BRAND_RGB,
                                 align=PP_ALIGN.LEFT)
                        cur_y = Cm(3.0)
                    sev_a = (ann.get("jerarquia") or "informativo").lower()
                    hexa = _severidad_hex(sev_a).lstrip("#")
                    sev_a_color = (int(hexa[0:2], 16), int(hexa[2:4], 16), int(hexa[4:6], 16))
                    add_text(an_slide, Cm(1.0), cur_y, Cm(4.5), Cm(0.6),
                             f"[ {_severidad_label(sev_a).upper()} ]",
                             size=10, bold=True, color=sev_a_color)
                    add_text(an_slide, Cm(5.5), cur_y, SW - Cm(7.0), Cm(0.6),
                             (ann.get("title") or "—").strip(),
                             size=12, bold=True, color=(0x0F, 0x17, 0x2A))
                    add_text(an_slide, Cm(5.5), cur_y + Cm(0.6),
                             SW - Cm(7.0), Cm(0.5),
                             f"({_fmt_fecha_dd_mm_yyyy(ann.get('created_at'))})",
                             size=9, italic=True, color=(0x64, 0x75, 0x8B))
                    body_text = (ann.get("body") or "").strip()
                    if body_text:
                        add_text(an_slide, Cm(5.5), cur_y + Cm(1.1),
                                 SW - Cm(7.0), Cm(1.2),
                                 body_text[:220] + ("…" if len(body_text) > 220 else ""),
                                 size=10, color=(0x0F, 0x17, 0x2A))
                    cur_y += Cm(2.5)

        if not any_data:
            s2 = prs.slides.add_slide(blank)
            add_header_footer(s2)
            add_text(s2, Cm(1.5), Cm(6.0), SW - Cm(3.0), Cm(2.0),
                     "Sin reportes en el período seleccionado.",
                     size=20, italic=True, color=(0x64, 0x75, 0x8B),
                     align=PP_ALIGN.CENTER)

        buf = io.BytesIO()
        prs.save(buf)
        return buf.getvalue()

    pptx_bytes = await asyncio.to_thread(_build_pptx_blocking)
    fname = _safe_export_filename(project_name, period, "pptx")
    return StreamingResponse(
        io.BytesIO(pptx_bytes),
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# === DAILY GOALS (Metas del día por proyecto) ==============================
class DailyGoalIn(BaseModel):
    text: str


class DailyGoalPatch(BaseModel):
    text: Optional[str] = None
    is_completed: Optional[bool] = None


def _goal_out(doc: dict) -> dict:
    doc.pop("_id", None)
    return doc


@api.get("/projects/{pid}/daily_goals")
async def list_daily_goals(pid: str, user: dict = Depends(current_user)):
    await ensure_project_access(user, pid)
    cur = db.daily_goals.find({"project_id": pid}).sort("created_at", 1)
    out = []
    async for d in cur:
        out.append(_goal_out(d))
    return out


@api.post("/projects/{pid}/daily_goals")
async def create_daily_goal(pid: str, body: DailyGoalIn, user: dict = Depends(current_user)):
    if user["role"] not in (ROLE_COORD, ROLE_JEFE, ROLE_SUB):
        raise HTTPException(403, "Solo coord, jefe o sub-coordinador pueden crear metas")
    await ensure_project_access(user, pid)
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "El texto es obligatorio")
    gid = str(uuid.uuid4())
    doc = {
        "id": gid,
        "project_id": pid,
        "text": text,
        "is_completed": False,
        "created_at": datetime.now(timezone.utc),
        "created_by": user["id"],
        "created_by_name": user.get("name", ""),
    }
    await db.daily_goals.insert_one(doc)
    return _goal_out(doc)


@api.patch("/projects/{pid}/daily_goals/{gid}")
async def update_daily_goal(pid: str, gid: str, body: DailyGoalPatch, user: dict = Depends(current_user)):
    if user["role"] not in (ROLE_COORD, ROLE_JEFE, ROLE_SUB):
        raise HTTPException(403, "Solo coord, jefe o sub-coordinador pueden modificar metas")
    await ensure_project_access(user, pid)
    upd: dict = {}
    if body.text is not None:
        t = body.text.strip()
        if not t:
            raise HTTPException(400, "Texto inválido")
        upd["text"] = t
    if body.is_completed is not None:
        upd["is_completed"] = bool(body.is_completed)
    if upd:
        res = await db.daily_goals.update_one({"id": gid, "project_id": pid}, {"$set": upd})
        if res.matched_count == 0:
            raise HTTPException(404, "Meta no encontrada")
    out = await db.daily_goals.find_one({"id": gid, "project_id": pid})
    if not out:
        raise HTTPException(404, "Meta no encontrada")
    return _goal_out(out)


@api.delete("/projects/{pid}/daily_goals/{gid}")
async def delete_daily_goal(pid: str, gid: str, user: dict = Depends(current_user)):
    if user["role"] not in (ROLE_COORD, ROLE_JEFE, ROLE_SUB):
        raise HTTPException(403, "Solo coord, jefe o sub-coordinador pueden eliminar metas")
    await ensure_project_access(user, pid)
    res = await db.daily_goals.delete_one({"id": gid, "project_id": pid})
    if res.deleted_count == 0:
        raise HTTPException(404, "Meta no encontrada")
    return {"ok": True}


# === AI Summary (Resumen Ejecutivo con IA) ==================================
class AISummaryResponse(BaseModel):
    summary: str
    reports_count: int
    period_hours: int
    generated_at: datetime


@api.post("/projects/{pid}/ai_summary", response_model=AISummaryResponse)
async def project_ai_summary(pid: str, user: dict = Depends(current_user)):
    """Genera un resumen ejecutivo (3 viñetas) usando IA con base en los
    reportes de las últimas 24h del proyecto. Disponible para todos los roles
    con acceso al proyecto."""
    await ensure_project_access(user, pid)

    if not EMERGENT_LLM_KEY:
        raise HTTPException(500, "EMERGENT_LLM_KEY no configurada en el servidor.")

    since = datetime.now(timezone.utc) - timedelta(hours=24)
    q: dict = {"project_id": pid, "created_at": {"$gte": since}}
    # Aplica el mismo scope RBAC que el feed.
    if user["role"] == ROLE_ESPECIALISTA:
        scope = user.get("scope_node_ids") or []
        q["node_id"] = {"$in": scope}
    # Sub-coordinador: scope GLOBAL (sin restricción).

    raw = await db.reports.find(q).sort("created_at", -1).to_list(length=500)

    if not raw:
        return AISummaryResponse(
            summary=(
                "• No se registraron reportes en las últimas 24 horas.\n"
                "• Equipo y personal sin movimientos capturados.\n"
                "• Recomendación: validar con sub-coordinadores el estado de avance del día."
            ),
            reports_count=0,
            period_hours=24,
            generated_at=datetime.now(timezone.utc),
        )

    # Formatea reportes como texto plano legible para el LLM.
    lines: List[str] = []
    for r in raw:
        path = " › ".join(r.get("node_path_names") or []) or "(sin nodo)"
        area = r.get("area_name") or "—"
        avance = r.get("avance") or "—"
        contratista = r.get("contratista") or "—"
        personnel = ", ".join(r.get("personnel") or []) or "—"
        equipment = ", ".join(r.get("equipment") or []) or "—"
        captured_by = r.get("captured_by_name") or "—"
        created = r.get("created_at")
        created_s = created.isoformat() if isinstance(created, datetime) else str(created)
        lines.append(
            f"- [{created_s}] {path} | Área: {area} | Avance: {avance} | "
            f"Contratista: {contratista} | Personal: {personnel} | "
            f"Equipo: {equipment} | Capturó: {captured_by}"
        )
    body = "\n".join(lines)

    system_message = (
        "ERES UN ANALISTA DE OBRA CIVIL DE NIVEL EJECUTIVO. TUS REGLAS SON INQUEBRANTABLES:\n"
        "1) NO PUEDES INVENTAR DATOS (ALUCINAR). SI NO HAY INFORMACIÓN, REPORTA QUE EL DATO NO ESTÁ DISPONIBLE.\n"
        "2) NO PUEDES FALLAR.\n"
        "3) TU ÚNICA FUNCIÓN ES RESUMIR EXACTAMENTE LO QUE DICEN LOS REPORTES SIN AGREGAR INTERPRETACIONES AJENAS.\n"
        "4) ESTRUCTURA: SOLO 3 VIÑETAS EJECUTIVAS Y NADA MÁS.\n\n"
        "Responde SIEMPRE en español. Cada viñeta debe iniciar con '• '. "
        "Distribución sugerida: una viñeta para avances, una para equipo/maquinaria y una para personal. "
        "Si alguna categoría no tiene datos, indícalo explícitamente como 'No disponible en los reportes'. "
        "Cero relleno, sin introducciones ni cierres."
    )
    user_text = (
        f"Reportes de las últimas 24 horas del proyecto (id={pid}). "
        f"Total: {len(raw)} entradas.\n\n{body}\n\n"
        "Genera el resumen ejecutivo solicitado."
    )

    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        chat = (
            LlmChat(
                api_key=EMERGENT_LLM_KEY,
                session_id=f"ai_summary_{pid}_{uuid.uuid4().hex[:8]}",
                system_message=system_message,
            )
            .with_model("openai", "gpt-4o-mini")
            .with_params(max_tokens=400)
        )
        reply = await chat.send_message(UserMessage(text=user_text))
        summary = (reply or "").strip() if isinstance(reply, str) else str(reply).strip()
        if not summary:
            raise RuntimeError("Respuesta vacía del LLM")
    except Exception as e:
        log.exception("[ai_summary] LLM error: %s", e)
        raise HTTPException(502, f"No se pudo generar el resumen con IA: {e}")

    return AISummaryResponse(
        summary=summary,
        reports_count=len(raw),
        period_hours=24,
        generated_at=datetime.now(timezone.utc),
    )


# === MOUNT ==================================================================
app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)