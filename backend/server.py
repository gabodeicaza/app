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
from fastapi import FastAPI, APIRouter, HTTPException, Depends, Query
from fastapi.responses import StreamingResponse
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
    created_at: datetime


class ProjectIn(BaseModel):
    name: str
    constructora: str
    contract_number: str
    start_date: Optional[str] = None  # ISO date "2026-01-15"
    end_date: Optional[str] = None
    description: Optional[str] = None
    reference_files: Optional[List[dict]] = None  # [{"name": str, "url": str}]
    contratistas_list: Optional[List[str]] = None  # Catálogo dinámico de contratistas
    contratos_list: Optional[List[str]] = None  # Catálogo dinámico de números de contrato


class ProjectOut(BaseModel):
    id: str
    name: str
    constructora: str
    contract_number: str
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    description: Optional[str] = None
    reference_files: List[dict] = Field(default_factory=list)
    contratistas_list: List[str] = Field(default_factory=list)
    contratos_list: List[str] = Field(default_factory=list)
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
    role: Literal["sub_coordinador", "especialista"]
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
    measurement_type: str
    measurement_value: dict
    area_id: Optional[str] = None
    area_name: Optional[str] = None
    notes: Optional[str] = None
    avance: Optional[str] = None
    observaciones: Optional[str] = None
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
        "start_date": body.start_date,
        "end_date": body.end_date,
        "description": (body.description or "").strip() or None,
        "reference_files": _sanitize_reference_files(body.reference_files),
        "contratistas_list": _sanitize_str_list(body.contratistas_list),
        "contratos_list": _sanitize_str_list(body.contratos_list),
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
    return p


@api.put("/projects/{pid}")
async def update_project(pid: str, body: ProjectIn, user: dict = Depends(require_role(ROLE_COORD))):
    upd = {
        "name": body.name.strip(),
        "constructora": body.constructora.strip(),
        "contract_number": body.contract_number.strip(),
        "start_date": body.start_date,
        "end_date": body.end_date,
        "description": (body.description or "").strip() or None,
    }
    # Sólo sobrescribimos reference_files si vienen explícitos en el payload
    if body.reference_files is not None:
        upd["reference_files"] = _sanitize_reference_files(body.reference_files)
    if body.contratistas_list is not None:
        upd["contratistas_list"] = _sanitize_str_list(body.contratistas_list)
    if body.contratos_list is not None:
        upd["contratos_list"] = _sanitize_str_list(body.contratos_list)
    r = await db.projects.update_one({"id": pid}, {"$set": upd})
    if r.matched_count == 0:
        raise HTTPException(404, "Proyecto no existe")
    p = await db.projects.find_one({"id": pid})
    p.pop("_id", None)
    p.setdefault("reference_files", [])
    p.setdefault("contratistas_list", [])
    p.setdefault("contratos_list", [])
    return p


@api.put("/projects/{pid}/catalogos")
async def set_project_catalogos(
    pid: str,
    body: dict,
    user: dict = Depends(require_role(ROLE_COORD)),
):
    """Actualiza únicamente los catálogos dinámicos del proyecto:
    contratistas_list y/o contratos_list. Sólo Coordinador General."""
    upd: dict = {}
    if isinstance(body.get("contratistas_list"), list):
        upd["contratistas_list"] = _sanitize_str_list(body.get("contratistas_list"))
    if isinstance(body.get("contratos_list"), list):
        upd["contratos_list"] = _sanitize_str_list(body.get("contratos_list"))
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
    # Filtrado por scope para Sub-coordinador / Especialista
    role = user.get("role")
    if role == ROLE_SUB and user.get("scope_node_id"):
        allowed = set(await descendants_ids(user["scope_node_id"]))
        items = [it for it in items if it["id"] in allowed]
    elif role == ROLE_SPEC and (user.get("scope_node_ids") or []):
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
    return items


@api.get("/projects/{pid}/nodes/tree")
async def get_tree(pid: str, user: dict = Depends(current_user)):
    """Devuelve el árbol completo como estructura jerárquica."""
    await ensure_project_access(user, pid)
    items = await db.location_nodes.find({"project_id": pid}).sort([("depth", 1), ("order", 1)]).to_list(length=10000)
    # Filtrado por scope (sub-coord / especialista)
    role = user.get("role")
    if role == ROLE_SUB and user.get("scope_node_id"):
        allowed = set(await descendants_ids(user["scope_node_id"]))
        items = [it for it in items if it["id"] in allowed]
    elif role == ROLE_SPEC and (user.get("scope_node_ids") or []):
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
    # Validar email no exista YA con cuenta activa
    existing_user = await db.users.find_one({"email": email})
    if existing_user:
        # OK si es el mismo usuario que será agregado a un nuevo proyecto, sino conflicto
        raise HTTPException(409, "Email ya registrado en el sistema")
    # Validaciones por rol
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
        raise HTTPException(409, "Email ya tiene cuenta")
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
        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            raise HTTPException(400, "Coordenadas fuera de rango")
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
    elif user["role"] == ROLE_SUB and user.get("scope_node_id"):
        allowed = await descendants_ids(user["scope_node_id"])
        if body.node_id not in allowed:
            raise HTTPException(403, "Nodo fuera de tu scope autorizado")
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
    doc = {
        "id": str(uuid.uuid4()),
        "project_id": body.project_id,
        "node_id": body.node_id,
        "node_path_names": path_names,
        "measurement_type": node["measurement_type"],
        "measurement_value": mv,
        "node_target": {
            "lat": node.get("target_lat"),
            "lon": node.get("target_lon"),
            "elev": node.get("target_elev"),
        } if node.get("measurement_type") == "coord_latlon" else None,
        "area_id": body.area_id or user.get("area_id"),
        "area_name": area_name,
        "notes": (body.notes or "").strip() or None,
        "avance": (body.avance or "").strip() or None,
        "observaciones": (body.observaciones or "").strip() or None,
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
    return doc


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
    elif user["role"] == ROLE_SUB and user.get("scope_node_id"):
        allowed = await descendants_ids(user["scope_node_id"])
        if nid not in allowed:
            raise HTTPException(403, "Nodo fuera de tu scope")

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
    if user["role"] == ROLE_SUB and user.get("scope_node_id"):
        allowed = await descendants_ids(user["scope_node_id"])
        q["node_id"] = {"$in": allowed}
    elif user["role"] == ROLE_ESPECIALISTA:
        scope = user.get("scope_node_ids") or []
        q["node_id"] = {"$in": scope}
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
    if user["role"] == ROLE_SUB and user.get("scope_node_id"):
        allowed = await descendants_ids(user["scope_node_id"])
        q["node_id"] = {"$in": allowed}
    elif user["role"] == ROLE_ESPECIALISTA:
        scope = user.get("scope_node_ids") or []
        q["node_id"] = {"$in": scope}

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
    if user["role"] == ROLE_SUB and user.get("scope_node_id"):
        allowed = await descendants_ids(user["scope_node_id"])
        if r["node_id"] not in allowed:
            raise HTTPException(403, "Sin acceso a este reporte")
    elif user["role"] == ROLE_ESPECIALISTA:
        if r["node_id"] not in (user.get("scope_node_ids") or []):
            raise HTTPException(403, "Sin acceso a este reporte")
    r.pop("_id", None)
    return r


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
    (usado para el selector de Mensajes Directos)."""
    await ensure_project_access(user, pid)
    items = await db.users.find({"project_ids": pid}).to_list(length=1000)
    return [user_to_out(u) for u in items]


@api.get("/projects/{pid}/members")
async def list_project_members(pid: str, user: dict = Depends(current_user)):
    """Alias semántico de /users — lista miembros del proyecto."""
    await ensure_project_access(user, pid)
    items = await db.users.find({"project_ids": pid}).to_list(length=1000)
    return [user_to_out(u) for u in items]


# === ANNOUNCEMENTS (Noticias) ==============================================
class AnnouncementIn(BaseModel):
    title: str
    body: str
    pinned: bool = False
    jerarquia: Optional[str] = None  # 'urgente' | 'importante' | 'informativo' | None
    audiencia: Optional[str] = None  # 'general' o area_id


class AnnouncementPatch(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    pinned: Optional[bool] = None
    jerarquia: Optional[str] = None
    audiencia: Optional[str] = None


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
    # Normaliza jerarquía: 'urgente' | 'importante' | 'informativo' | None
    jerarquia = (body.jerarquia or "").strip().lower() or None
    if jerarquia and jerarquia not in ("urgente", "importante", "informativo"):
        raise HTTPException(400, "Jerarquía inválida")
    # Audiencia: "general" (proyecto completo) o area_id
    audiencia = (body.audiencia or "").strip() or "general"
    if audiencia != "general":
        area = await db.areas.find_one({"id": audiencia, "project_id": pid})
        if not area:
            raise HTTPException(400, "Audiencia (área) inválida")
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "project_id": pid,
        "title": title,
        "body": text,
        "pinned": bool(body.pinned),
        "jerarquia": jerarquia,
        "audiencia": audiencia,
        "author_id": user["id"],
        "author_name": user["name"],
        "author_role": user["role"],
        "created_at": now,
        "updated_at": now,
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
    if body.jerarquia is not None:
        j = (body.jerarquia or "").strip().lower()
        if j == "":
            update["jerarquia"] = None
        elif j in ("urgente", "importante", "informativo"):
            update["jerarquia"] = j
        else:
            raise HTTPException(400, "Jerarquía inválida")
    if body.audiencia is not None:
        aud = (body.audiencia or "").strip() or "general"
        if aud != "general":
            area = await db.areas.find_one({"id": aud, "project_id": a["project_id"]})
            if not area:
                raise HTTPException(400, "Audiencia (área) inválida")
        update["audiencia"] = aud
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
    if user["role"] == ROLE_COORD:
        # Coord global access — pero igual valida pertenencia básica al proyecto
        return pid in project_ids
    if pid not in project_ids:
        return False
    if ch["type"] == "general":
        return True
    if ch["type"] == "area":
        # Especialistas con area_id que coincide. Sub-coords no pertenecen a un área.
        return user.get("area_id") and user.get("area_id") == ch.get("area_id")
    if ch["type"] == "direct":
        return user["id"] in (ch.get("member_ids") or [])
    return False


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
    if pid not in (target.get("project_ids") or []):
        raise HTTPException(404, "Ese usuario no pertenece al proyecto")
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


# === EVENTS (Calendario compartido) ========================================
class EventIn(BaseModel):
    title: str
    description: Optional[str] = None
    location: Optional[str] = None
    start_at: str  # ISO 8601
    end_at: Optional[str] = None


class EventPatch(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    location: Optional[str] = None
    start_at: Optional[str] = None
    end_at: Optional[str] = None


def _event_out(doc: dict) -> dict:
    doc.pop("_id", None)
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
    return [_event_out(it) for it in items]


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
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "project_id": pid,
        "title": title,
        "description": desc,
        "location": loc,
        "start_at": start,
        "end_at": end,
        "author_id": user["id"],
        "author_name": user["name"],
        "author_role": user["role"],
        "created_at": now,
        "updated_at": now,
    }
    await db.events.insert_one(doc)
    return _event_out(doc)


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
    start_final = update.get("start_at", e["start_at"])
    end_final = update.get("end_at", e.get("end_at"))
    if end_final and end_final < start_final:
        raise HTTPException(400, "La fecha de fin no puede ser anterior al inicio")
    if not update:
        return _event_out(e)
    update["updated_at"] = datetime.now(timezone.utc)
    await db.events.update_one({"id": eid}, {"$set": update})
    e = await db.events.find_one({"id": eid})
    return _event_out(e)


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


@api.get("/projects/{pid}/export/reports.pdf")
async def export_reports_pdf(
    pid: str,
    period: str = Query("today", description="today|yesterday|week|month"),
    user: dict = Depends(current_user),
):
    """Motor PDF paramétrico (Coord = todos / Esp = propios / Sub = scope).
    Render bloqueante (reportlab) ejecutado en thread aparte para no congelar
    el event loop ante muchas fotos en periodos largos (week / month)."""
    try:
        import base64
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.units import cm
        from reportlab.lib.colors import HexColor
        from reportlab.lib.utils import ImageReader
        from reportlab.pdfgen import canvas as _canvas
    except Exception as e:
        raise HTTPException(500, f"reportlab no instalado: {e}")

    await ensure_project_access(user, pid)
    proj = await db.projects.find_one({"id": pid})
    if not proj:
        raise HTTPException(404, "Proyecto no existe")

    start_dt, end_dt, period_label = _period_range(period)

    # --- Carga árbol y nodos -------------------------------------------------
    nodes_raw = await db.location_nodes.find({"project_id": pid}).to_list(length=10000)
    nodes_by_id = {n["id"]: n for n in nodes_raw}
    root_ids = [n["id"] for n in nodes_raw if not n.get("parent_id")]
    root_ids.sort(key=lambda nid: (nodes_by_id[nid].get("order", 0), nodes_by_id[nid].get("name", "")))
    leaf_nodes = _flatten_tree_in_order(nodes_by_id, root_ids)

    # --- Filtro scope por rol ------------------------------------------------
    role = user["role"]
    allowed_node_ids: Optional[set] = None
    if role == ROLE_SUB:
        scope_ids = user.get("scope_node_ids") or []
        if not scope_ids:
            allowed_node_ids = set()
        else:
            descendants: set = set()
            for sid in scope_ids:
                for d in await descendants_ids(sid):
                    descendants.add(d)
            allowed_node_ids = descendants

    # --- Query reportes del período -----------------------------------------
    q: dict = {
        "project_id": pid,
        "created_at": {"$gte": start_dt, "$lte": end_dt},
    }
    if role != ROLE_COORD:
        q["captured_by"] = user["id"]
    if allowed_node_ids is not None:
        q["node_id"] = {"$in": list(allowed_node_ids)}

    reports = await db.reports.find(q).to_list(length=20000)
    reports_by_node: dict = {}
    for r in reports:
        reports_by_node.setdefault(r.get("node_id"), []).append(r)
    for nid, lst in reports_by_node.items():
        lst.sort(key=lambda r: r.get("created_at") or datetime.min)

    # --- Primera lectura inicial por nodo (último reporte ANTERIOR al periodo)
    # Si no hay histórico previo → primera = 0.0
    prev_reading_by_node: dict = {}
    for nid in reports_by_node.keys():
        pre_q: dict = {
            "project_id": pid,
            "node_id": nid,
            "created_at": {"$lt": start_dt},
        }
        if role != ROLE_COORD:
            pre_q["captured_by"] = user["id"]
        prev = await db.reports.find(pre_q).sort("created_at", -1).limit(1).to_list(length=1)
        prev_reading_by_node[nid] = _extract_numeric_reading(prev[0]) if prev else None

    # --- Rutas de nodos (cache) ---------------------------------------------
    path_cache: dict = {}
    for nid in list(reports_by_node.keys()):
        names = await node_path_names(nid)
        path_cache[nid] = " › ".join(names)

    # Snapshot inmutable para el thread bloqueante
    project_name = proj.get("name", "Proyecto")
    project_contract = proj.get("contract_number") or "—"
    project_constructora = proj.get("constructora") or "—"
    user_name = user.get("name", "")
    user_email = user.get("email", "")
    role_label = (
        "Coordinador" if role == ROLE_COORD
        else ("Especialista" if role == ROLE_ESPECIALISTA else "Sub-Coordinador")
    )

    # ========================================================================
    # GENERACIÓN BLOQUEANTE (CPU-bound) → asyncio.to_thread
    # ========================================================================
    def _build_pdf_blocking() -> bytes:
        buf = io.BytesIO()
        PAGE = landscape(A4)  # 29.7 x 21 cm
        PW, PH = PAGE
        c = _canvas.Canvas(buf, pagesize=PAGE)

        BRAND = HexColor("#1E3A8A")
        MUTED = HexColor("#64748B")
        BORDER = HexColor("#E2E8F0")
        TEXT = HexColor("#0F172A")

        def draw_header(page_num: int):
            if LOGO_PATH.exists():
                try:
                    logo = ImageReader(str(LOGO_PATH))
                    c.drawImage(logo, 1.2 * cm, PH - 1.9 * cm, width=3.0 * cm, height=1.2 * cm,
                                preserveAspectRatio=True, mask='auto')
                except Exception:
                    pass
            c.setFillColor(BRAND)
            c.setFont("Helvetica-Bold", 11)
            c.drawString(4.0 * cm, PH - 1.2 * cm, f"SynCo · {project_name}")
            c.setFillColor(MUTED)
            c.setFont("Helvetica", 8)
            c.drawString(4.0 * cm, PH - 1.6 * cm,
                         f"Reporte {period_label} · Exportado {datetime.now(timezone.utc).astimezone(MX_TZ).strftime('%Y-%m-%d %H:%M')} (CDMX)")
            c.setStrokeColor(BORDER)
            c.setLineWidth(0.5)
            c.line(1.2 * cm, PH - 2.0 * cm, PW - 1.2 * cm, PH - 2.0 * cm)
            c.setFillColor(MUTED)
            c.setFont("Helvetica", 7)
            c.drawRightString(PW - 1.2 * cm, 0.8 * cm, f"Página {page_num}")

        # --- PORTADA --------------------------------------------------------
        page_num = 1
        if LOGO_PATH.exists():
            try:
                logo = ImageReader(str(LOGO_PATH))
                c.drawImage(logo, (PW - 8 * cm) / 2, PH - 6.5 * cm, width=8 * cm, height=3 * cm,
                            preserveAspectRatio=True, mask='auto')
            except Exception:
                pass
        c.setFillColor(BRAND)
        c.setFont("Helvetica-Bold", 28)
        c.drawCentredString(PW / 2, PH - 8.5 * cm, "Reporte de Avance")
        c.setFillColor(TEXT)
        c.setFont("Helvetica-Bold", 18)
        c.drawCentredString(PW / 2, PH - 9.8 * cm, project_name)
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 12)
        c.drawCentredString(PW / 2, PH - 11.2 * cm, f"Período: {period_label}")
        c.drawCentredString(PW / 2, PH - 12.0 * cm,
                            f"{(start_dt.astimezone(MX_TZ) if start_dt.tzinfo else start_dt.replace(tzinfo=timezone.utc).astimezone(MX_TZ)).strftime('%Y-%m-%d %H:%M')} – {(end_dt.astimezone(MX_TZ) if end_dt.tzinfo else end_dt.replace(tzinfo=timezone.utc).astimezone(MX_TZ)).strftime('%Y-%m-%d %H:%M')} (CDMX)")
        c.setFont("Helvetica-Bold", 11)
        c.setFillColor(TEXT)
        c.drawCentredString(PW / 2, PH - 13.5 * cm, f"{role_label}: {user_name}")
        c.setFont("Helvetica", 10)
        c.setFillColor(MUTED)
        c.drawCentredString(PW / 2, PH - 14.2 * cm, user_email)
        total_reportes = sum(len(v) for v in reports_by_node.values())
        c.drawCentredString(PW / 2, PH - 15.5 * cm, f"Total de reportes incluidos: {total_reportes}")
        c.setFont("Helvetica", 7)
        c.drawRightString(PW - 1.2 * cm, 0.8 * cm, f"Página {page_num}")
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
            mtype = n.get("measurement_type") or "—"
            actividad = f"Supervisión de obra / {_measurement_label(mtype)}"

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
                fecha_str = _fmt_fecha_es(ts) if isinstance(ts, datetime) else "—"
                nombre = r.get("captured_by_name") or "—"
                # Constructora siempre desde el proyecto (P0 fix v2.0)
                contratista = (project_constructora or "").strip() or "N/A"
                unidad_r = (r.get("unidad") or "m").strip() or "m"
                personal_list = [p for p in (r.get("personnel") or []) if p]
                equipo_list = [e for e in (r.get("equipment") or []) if e]
                personal_str = ", ".join(personal_list) if personal_list else "N/A"
                equipo_str = ", ".join(equipo_list) if equipo_list else "N/A"
                obs_str = (r.get("notes") or "").strip() or "N/A"

                def field(label: str, value, font="Helvetica", size=9.5, leading=12):
                    nonlocal cy
                    c.setFillColor(BRAND)
                    c.setFont("Helvetica-Bold", 9)
                    c.drawString(data_x, cy, label.upper())
                    cy -= 0.42 * cm
                    cy = render_text_block(data_x, cy, data_w, [str(value)],
                                           font=font, size=size, leading=leading)
                    cy -= 0.20 * cm

                field("Fecha", fecha_str)
                field("Nombre", nombre)
                field("Actividad", actividad)
                field("No. De Contrato", project_contract)
                field("Contratista", contratista)
                field("Ubicación", node_path)
                field("Reporte de avance",
                      f"Primera lectura: {primera_str} {unidad_r}    |    Última lectura: {ultima_str} {unidad_r}    |    Avance: {avance_str}")
                field("Personal", personal_str)
                field("Equipo", equipo_str)
                field("Observaciones", obs_str)

                # Pie del reporte
                c.setFillColor(MUTED)
                c.setFont("Helvetica-Oblique", 8)
                c.drawString(photo_x, photo_y - 0.5 * cm, f"Capturado por: {nombre}")

                c.showPage()
                page_num += 1

        c.save()
        return buf.getvalue()

    # Render bloqueante en thread aparte → libera event loop
    pdf_bytes = await asyncio.to_thread(_build_pdf_blocking)
    safe_name = re.sub(r"[^A-Za-z0-9_-]+", "_", proj.get("name", "proyecto"))[:60] or "proyecto"
    fname = f"synco_{safe_name}_{period}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M')}.pdf"
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

async def _gather_export_data(pid: str, period: str, user: dict) -> dict:
    """Carga proyecto, nodos, reportes y rutas aplicando el filtro de rol/scope.
    Devuelve un dict listo para que docx/pptx (CPU-bound) generen el binario."""
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
    allowed_node_ids: Optional[set] = None
    if role == ROLE_SUB:
        scope_ids = user.get("scope_node_ids") or []
        if not scope_ids:
            allowed_node_ids = set()
        else:
            descendants: set = set()
            for sid in scope_ids:
                for d in await descendants_ids(sid):
                    descendants.add(d)
            allowed_node_ids = descendants

    q: dict = {
        "project_id": pid,
        "created_at": {"$gte": start_dt, "$lte": end_dt},
    }
    if role == ROLE_ESPECIALISTA:
        q["captured_by"] = user["id"]
    if allowed_node_ids is not None:
        q["node_id"] = {"$in": list(allowed_node_ids)}

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

    return {
        "proj": proj,
        "leaf_nodes": leaf_nodes,
        "reports_by_node": reports_by_node,
        "path_cache": path_cache,
        "period_label": period_label,
        "user": user,
    }


def _safe_export_filename(name: str, period: str, ext: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]+", "_", name or "proyecto")[:60] or "proyecto"
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M")
    return f"synco_{safe}_{period}_{ts}.{ext}"


@api.get("/projects/{pid}/export/reports.docx")
async def export_reports_docx(
    pid: str,
    period: str = Query("today", description="today|yesterday|week|month"),
    user: dict = Depends(current_user),
):
    """Exporta reportes en formato Microsoft Word (.docx). 100 % en RAM."""
    try:
        import base64
        from docx import Document
        from docx.shared import Cm, Pt, RGBColor
        from docx.enum.text import WD_ALIGN_PARAGRAPH
    except Exception as e:
        raise HTTPException(500, f"python-docx no instalado: {e}")

    data = await _gather_export_data(pid, period, user)
    proj = data["proj"]
    leaf_nodes = data["leaf_nodes"]
    reports_by_node = data["reports_by_node"]
    path_cache = data["path_cache"]
    period_label = data["period_label"]

    project_name = proj.get("name", "Proyecto")
    project_contract = proj.get("contract_number") or "—"
    project_constructora = proj.get("constructora") or "—"

    def _build_docx_blocking() -> bytes:
        doc = Document()
        # Márgenes ajustados
        for section in doc.sections:
            section.left_margin = Cm(1.8)
            section.right_margin = Cm(1.8)
            section.top_margin = Cm(1.8)
            section.bottom_margin = Cm(1.8)

        # === PORTADA ===
        h = doc.add_paragraph()
        h.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = h.add_run(f"SynCo · {project_name}")
        run.bold = True
        run.font.size = Pt(20)
        run.font.color.rgb = RGBColor(0x1E, 0x3A, 0x8A)

        sub = doc.add_paragraph()
        sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
        sr = sub.add_run(f"Reporte exportado · {period_label}")
        sr.font.size = Pt(12)
        sr.font.color.rgb = RGBColor(0x64, 0x75, 0x8B)

        meta = doc.add_paragraph()
        meta.alignment = WD_ALIGN_PARAGRAPH.CENTER
        mr = meta.add_run(
            f"Contrato: {project_contract}    ·    Constructora: {project_constructora}"
        )
        mr.font.size = Pt(10)
        mr.font.color.rgb = RGBColor(0x64, 0x75, 0x8B)

        date_p = doc.add_paragraph()
        date_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        dr = date_p.add_run(datetime.now(timezone.utc).strftime("Generado %Y-%m-%d %H:%M UTC"))
        dr.font.size = Pt(9)
        dr.font.color.rgb = RGBColor(0x94, 0xA3, 0xB8)

        any_data = False

        for n in leaf_nodes:
            node_reps = reports_by_node.get(n["id"]) or []
            if not node_reps:
                continue
            any_data = True
            node_path = path_cache.get(n["id"]) or n.get("name", "")
            mtype = n.get("measurement_type") or "—"
            actividad = f"Supervisión de obra / {_measurement_label(mtype)}"

            # Separador por nodo
            doc.add_page_break()
            np = doc.add_paragraph()
            np.alignment = WD_ALIGN_PARAGRAPH.CENTER
            nr = np.add_run(node_path)
            nr.bold = True
            nr.font.size = Pt(18)
            nr.font.color.rgb = RGBColor(0x1E, 0x3A, 0x8A)

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

                # Foto centrada
                img_b64 = None
                imgs = r.get("images") or []
                if imgs:
                    img_b64 = _strip_b64_prefix(imgs[0])
                if img_b64:
                    try:
                        raw = base64.b64decode(img_b64)
                        img_buf = io.BytesIO(raw)
                        img_p = doc.add_paragraph()
                        img_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                        img_p.add_run().add_picture(img_buf, width=Cm(10))
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
                fecha_str = _fmt_fecha_es(ts) if isinstance(ts, datetime) else "—"
                nombre = r.get("captured_by_name") or "—"
                contratista_rep = (r.get("contratista") or "").strip() or (project_constructora or "—")
                contrato_rep = (r.get("contract_number") or "").strip() or project_contract
                unidad_r = (r.get("unidad") or "m").strip() or "m"
                personal_list = [p for p in (r.get("personnel") or []) if p]
                equipo_list = [e for e in (r.get("equipment") or []) if e]
                personal_str = ", ".join(personal_list) if personal_list else "N/A"
                equipo_str = ", ".join(equipo_list) if equipo_list else "N/A"
                obs_str = (r.get("notes") or "").strip() or "N/A"

                table = doc.add_table(rows=0, cols=2)
                table.autofit = True

                def _row(label: str, value: str):
                    row = table.add_row().cells
                    pl = row[0].paragraphs[0]
                    plr = pl.add_run(label.upper())
                    plr.bold = True
                    plr.font.size = Pt(9)
                    plr.font.color.rgb = RGBColor(0x1E, 0x3A, 0x8A)
                    pv = row[1].paragraphs[0]
                    pvr = pv.add_run(str(value))
                    pvr.font.size = Pt(10)
                    pvr.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)

                _row("Fecha", fecha_str)
                _row("Nombre", nombre)
                _row("Actividad", actividad)
                _row("No. De Contrato", contrato_rep)
                _row("Contratista", contratista_rep)
                _row("Ubicación", node_path)
                _row("Reporte de avance",
                     f"Primera: {primera_str} {unidad_r}  |  Última: {ultima_str} {unidad_r}  |  Avance: {avance_str}")
                _row("Personal", personal_str)
                _row("Equipo", equipo_str)
                _row("Observaciones", obs_str)

                foot = doc.add_paragraph()
                foot.alignment = WD_ALIGN_PARAGRAPH.LEFT
                fr = foot.add_run(f"Capturado por: {nombre}")
                fr.italic = True
                fr.font.size = Pt(8)
                fr.font.color.rgb = RGBColor(0x64, 0x75, 0x8B)

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
    user: dict = Depends(current_user),
):
    """Exporta reportes en formato PowerPoint (.pptx). 100 % en RAM."""
    try:
        import base64
        from pptx import Presentation
        from pptx.util import Cm, Pt, Emu
        from pptx.dml.color import RGBColor as PRGBColor
        from pptx.enum.text import PP_ALIGN
    except Exception as e:
        raise HTTPException(500, f"python-pptx no instalado: {e}")

    data = await _gather_export_data(pid, period, user)
    proj = data["proj"]
    leaf_nodes = data["leaf_nodes"]
    reports_by_node = data["reports_by_node"]
    path_cache = data["path_cache"]
    period_label = data["period_label"]

    project_name = proj.get("name", "Proyecto")
    project_contract = proj.get("contract_number") or "—"
    project_constructora = proj.get("constructora") or "—"

    def _build_pptx_blocking() -> bytes:
        prs = Presentation()
        prs.slide_width = Cm(25.4)
        prs.slide_height = Cm(14.29)  # 16:9
        SW, SH = prs.slide_width, prs.slide_height
        blank = prs.slide_layouts[6]

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

        # ===== PORTADA =====
        s = prs.slides.add_slide(blank)

        # Logo DIRAC en la portada (descarga 100% en RAM con BytesIO).
        # CERO huella local: no se escribe a disco.
        try:
            import requests as _http  # local import para no inflar el módulo
            _logo_url = (
                "https://customer-assets.emergentagent.com/"
                "job_offline-report-sync/artifacts/eprp6ziy_logo%20driac.png"
            )
            _logo_resp = _http.get(_logo_url, timeout=8)
            if _logo_resp.status_code == 200 and _logo_resp.content:
                _logo_buf = io.BytesIO(_logo_resp.content)
                _logo_w = Cm(5.0)
                _logo_h = Cm(2.2)
                _logo_x = (SW - _logo_w) // 2
                _logo_y = Cm(1.6)
                s.shapes.add_picture(_logo_buf, _logo_x, _logo_y,
                                     width=_logo_w, height=_logo_h)
        except Exception as _logo_err:  # pragma: no cover
            logging.warning("No se pudo incrustar logo DIRAC en PPTX: %s", _logo_err)

        add_text(s, Cm(1.5), Cm(4.5), SW - Cm(3.0), Cm(2.0),
                 f"SynCo · {project_name}",
                 size=36, bold=True, color=(0x1E, 0x3A, 0x8A), align=PP_ALIGN.CENTER)
        add_text(s, Cm(1.5), Cm(7.0), SW - Cm(3.0), Cm(1.0),
                 f"Reporte exportado · {period_label}",
                 size=18, color=(0x64, 0x75, 0x8B), align=PP_ALIGN.CENTER)
        add_text(s, Cm(1.5), Cm(8.5), SW - Cm(3.0), Cm(1.0),
                 f"Contrato: {project_contract}    ·    Constructora: {project_constructora}",
                 size=12, color=(0x64, 0x75, 0x8B), align=PP_ALIGN.CENTER)
        add_text(s, Cm(1.5), Cm(12.5), SW - Cm(3.0), Cm(0.8),
                 datetime.now(timezone.utc).strftime("Generado %Y-%m-%d %H:%M UTC"),
                 size=9, color=(0x94, 0xA3, 0xB8), align=PP_ALIGN.CENTER)

        any_data = False
        for n in leaf_nodes:
            node_reps = reports_by_node.get(n["id"]) or []
            if not node_reps:
                continue
            any_data = True
            node_path = path_cache.get(n["id"]) or n.get("name", "")
            mtype = n.get("measurement_type") or "—"
            actividad = f"Supervisión de obra / {_measurement_label(mtype)}"

            # === Slide separador por nodo ===
            s = prs.slides.add_slide(blank)
            add_text(s, Cm(1.5), Cm(5.0), SW - Cm(3.0), Cm(2.0),
                     node_path, size=32, bold=True, color=(0x1E, 0x3A, 0x8A),
                     align=PP_ALIGN.CENTER)
            try:
                coord_text = _format_measurement_for_display(node_reps[0]) or "—"
            except Exception:
                coord_text = "—"
            add_text(s, Cm(1.5), Cm(7.5), SW - Cm(3.0), Cm(1.0),
                     f"Coordenadas: {coord_text}",
                     size=16, color=(0x0F, 0x17, 0x2A), align=PP_ALIGN.CENTER)
            add_text(s, Cm(1.5), Cm(9.0), SW - Cm(3.0), Cm(1.0),
                     f"Reportes en este nodo: {len(node_reps)}",
                     size=12, color=(0x64, 0x75, 0x8B), align=PP_ALIGN.CENTER)

            for r in node_reps:
                slide = prs.slides.add_slide(blank)

                # Header
                add_text(slide, Cm(1.0), Cm(0.4), SW - Cm(2.0), Cm(0.8),
                         f"SynCo · {project_name}",
                         size=11, bold=True, color=(0x1E, 0x3A, 0x8A))

                # Foto izquierda
                photo_x = Cm(1.0)
                photo_y = Cm(1.6)
                photo_w = Cm(10.0)
                photo_h = Cm(11.0)
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
                        add_text(slide, photo_x, photo_y + Cm(5), photo_w, Cm(1.0),
                                 "(imagen no legible)", size=11,
                                 color=(0x64, 0x75, 0x8B), italic=True,
                                 align=PP_ALIGN.CENTER)
                else:
                    add_text(slide, photo_x, photo_y + Cm(5), photo_w, Cm(1.0),
                             "(sin fotografía)", size=11,
                             color=(0x64, 0x75, 0x8B), italic=True,
                             align=PP_ALIGN.CENTER)

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
                fecha_str = _fmt_fecha_es(ts) if isinstance(ts, datetime) else "—"
                nombre = r.get("captured_by_name") or "—"
                contratista_rep = (r.get("contratista") or "").strip() or (project_constructora or "—")
                contrato_rep = (r.get("contract_number") or "").strip() or project_contract
                unidad_r = (r.get("unidad") or "m").strip() or "m"
                personal_list = [p for p in (r.get("personnel") or []) if p]
                equipo_list = [e for e in (r.get("equipment") or []) if e]
                personal_str = ", ".join(personal_list) if personal_list else "N/A"
                equipo_str = ", ".join(equipo_list) if equipo_list else "N/A"
                obs_str = (r.get("notes") or "").strip() or "N/A"

                data_x = Cm(11.5)
                data_y = Cm(1.6)
                data_w = SW - data_x - Cm(1.0)

                rows = [
                    ("Fecha", fecha_str),
                    ("Nombre", nombre),
                    ("Actividad", actividad),
                    ("No. De Contrato", contrato_rep),
                    ("Contratista", contratista_rep),
                    ("Ubicación", node_path),
                    ("Reporte de avance",
                     f"P: {primera_str} {unidad_r}  |  U: {ultima_str} {unidad_r}  |  Avance: {avance_str}"),
                    ("Personal", personal_str),
                    ("Equipo", equipo_str),
                    ("Observaciones", obs_str[:240] + ("…" if len(obs_str) > 240 else "")),
                ]

                tb = slide.shapes.add_textbox(data_x, data_y, data_w, Cm(11.0))
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
                    r_lbl.font.color.rgb = PRGBColor(0x1E, 0x3A, 0x8A)
                    p_val = tf.add_paragraph()
                    p_val.alignment = PP_ALIGN.LEFT
                    r_val = p_val.add_run()
                    r_val.text = str(val)
                    r_val.font.size = Pt(10)
                    r_val.font.color.rgb = PRGBColor(0x0F, 0x17, 0x2A)
                    first = False

                # Footer
                add_text(slide, Cm(1.0), SH - Cm(0.8), SW - Cm(2.0), Cm(0.6),
                         f"Capturado por: {nombre}",
                         size=9, italic=True, color=(0x64, 0x75, 0x8B))

        if not any_data:
            s2 = prs.slides.add_slide(blank)
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
    if user["role"] == ROLE_SUB and user.get("scope_node_id"):
        allowed = await descendants_ids(user["scope_node_id"])
        q["node_id"] = {"$in": allowed}
    elif user["role"] == ROLE_ESPECIALISTA:
        scope = user.get("scope_node_ids") or []
        q["node_id"] = {"$in": scope}

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
