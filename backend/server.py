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
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Literal

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

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

app = FastAPI(title="SynCo v2.0 API")
api = APIRouter(prefix="/api")
bearer = HTTPBearer(auto_error=False)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("synco")


# === Constants =============================================================
ROLE_COORD = "coordinador_general"
ROLE_SUB = "sub_coordinador"
ROLE_ESPECIALISTA = "especialista"
VALID_ROLES = {ROLE_COORD, ROLE_SUB, ROLE_ESPECIALISTA}

MEASUREMENT_TYPES = {"coord_latlon", "cadenamiento", "eje", "nivel"}

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


class ProjectOut(BaseModel):
    id: str
    name: str
    constructora: str
    contract_number: str
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    description: Optional[str] = None
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
    contratista: Optional[str] = None
    personnel: List[str] = Field(default_factory=list)
    equipment: List[str] = Field(default_factory=list)
    images: List[str] = Field(default_factory=list)  # base64
    files: List[dict] = Field(default_factory=list)  # [{filename, mime, data_base64}]


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
    contratista: Optional[str] = None
    personnel: List[str] = Field(default_factory=list)
    equipment: List[str] = Field(default_factory=list)
    images: List[str] = Field(default_factory=list)
    files: List[dict] = Field(default_factory=list)
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
    if user["role"] == ROLE_COORD:
        return p  # acceso global
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
@api.get("/projects")
async def list_projects(user: dict = Depends(current_user)):
    if user["role"] == ROLE_COORD:
        cursor = db.projects.find({"archived": {"$ne": True}}).sort("created_at", -1)
    else:
        pids = user.get("project_ids") or []
        cursor = db.projects.find({"id": {"$in": pids}, "archived": {"$ne": True}}).sort("created_at", -1)
    items = await cursor.to_list(length=500)
    for it in items:
        it.pop("_id", None)
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
    r = await db.projects.update_one({"id": pid}, {"$set": upd})
    if r.matched_count == 0:
        raise HTTPException(404, "Proyecto no existe")
    p = await db.projects.find_one({"id": pid})
    p.pop("_id", None)
    return p


@api.delete("/projects/{pid}")
async def archive_project(pid: str, user: dict = Depends(require_role(ROLE_COORD))):
    await db.projects.update_one({"id": pid}, {"$set": {"archived": True}})
    return {"ok": True, "archived": True}


# === LOCATION NODES (Árbol Recursivo) =======================================
@api.get("/projects/{pid}/nodes")
async def list_nodes(pid: str, user: dict = Depends(current_user)):
    await ensure_project_access(user, pid)
    items = await db.location_nodes.find({"project_id": pid}).sort([("depth", 1), ("order", 1)]).to_list(length=10000)
    for it in items:
        it.pop("_id", None)
    return items


@api.get("/projects/{pid}/nodes/tree")
async def get_tree(pid: str, user: dict = Depends(current_user)):
    """Devuelve el árbol completo como estructura jerárquica."""
    await ensure_project_access(user, pid)
    items = await db.location_nodes.find({"project_id": pid}).sort([("depth", 1), ("order", 1)]).to_list(length=10000)
    by_id = {}
    for it in items:
        it.pop("_id", None)
        it["children"] = []
        by_id[it["id"]] = it
    roots = []
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


@api.patch("/nodes/{nid}")
async def update_node(nid: str, body: NodePatch, user: dict = Depends(require_role(ROLE_COORD))):
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
    if user["role"] not in (ROLE_ESPECIALISTA, ROLE_COORD):
        raise HTTPException(403, "Solo Especialistas (o Coordinador General) pueden capturar")
    await ensure_project_access(user, body.project_id)
    node = await db.location_nodes.find_one({"id": body.node_id, "project_id": body.project_id})
    if not node:
        raise HTTPException(404, "Nodo no existe en este proyecto")
    if not node.get("is_leaf"):
        raise HTTPException(400, "Solo se puede capturar en nodos hoja")
    if user["role"] == ROLE_ESPECIALISTA:
        if body.node_id not in (user.get("scope_node_ids") or []):
            raise HTTPException(403, "Nodo no está en tu scope autorizado")
    validate_measurement_value(node["measurement_type"], body.measurement_value)
    path_names = await node_path_names(body.node_id)
    area_name = None
    if body.area_id:
        a = await db.areas.find_one({"id": body.area_id, "project_id": body.project_id})
        if a:
            area_name = a["name"]
    elif user.get("area"):
        area_name = user["area"]
    doc = {
        "id": str(uuid.uuid4()),
        "project_id": body.project_id,
        "node_id": body.node_id,
        "node_path_names": path_names,
        "measurement_type": node["measurement_type"],
        "measurement_value": body.measurement_value,
        "node_target": {
            "lat": node.get("target_lat"),
            "lon": node.get("target_lon"),
            "elev": node.get("target_elev"),
        } if node.get("measurement_type") == "coord_latlon" else None,
        "area_id": body.area_id or user.get("area_id"),
        "area_name": area_name,
        "notes": (body.notes or "").strip() or None,
        "avance": (body.avance or "").strip() or None,
        "contratista": (body.contratista or "").strip() or None,
        "personnel": body.personnel,
        "equipment": body.equipment,
        "images": body.images,
        "files": body.files,
        "captured_by": user["id"],
        "captured_by_name": user["name"],
        "created_at": datetime.now(timezone.utc),
    }
    await db.reports.insert_one(doc)
    doc.pop("_id", None)
    return doc


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


class AnnouncementPatch(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    pinned: Optional[bool] = None


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
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "project_id": pid,
        "title": title,
        "body": text,
        "pinned": bool(body.pinned),
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
async def export_reports_xlsx(pid: str, user: dict = Depends(require_role(ROLE_COORD))):
    """Exporta TODOS los reportes del proyecto en una sábana Excel plana,
    iterando los nodos en orden jerárquico (Tramo → Estación → Poste).
    Incluye ruta del nodo y coordenadas dictadas (X, Y, Z). Sólo Coord."""
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


# === PDF EXPORT (Motor paramétrico unificado) ================================
# Reglas:
#   - COORDINADOR: ve TODOS los reportes del proyecto.
#   - ESPECIALISTA: sólo ve los reportes que ÉL capturó (captured_by == user.id).
#   - SUB-COORDINADOR: ve sólo reportes cuyos nodos caen dentro de su scope_node_ids
#                     (incluyendo todos los descendientes).
#   - Período: today | yesterday | week | month (ventana móvil sobre created_at).
#   - Layout: A4 horizontal. Portada con logo Dirac + fecha + autor + periodo.
#   - Cuerpo: jerarquía estricta del árbol. Por reporte: foto centrada
#            EXACTAMENTE 10 cm x 13.37 cm, debajo: Ruta / X,Y,Z / Avance / Observaciones.

LOGO_PATH = Path(__file__).resolve().parent / "assets" / "logo_dirac.png"


def _period_range(period: str) -> tuple:
    """Devuelve (start_utc, end_utc, etiqueta_legible)."""
    now = datetime.now(timezone.utc)
    p = (period or "today").lower().strip()
    if p in ("today", "hoy"):
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return start, now, "Hoy"
    if p in ("yesterday", "ayer"):
        end = now.replace(hour=0, minute=0, second=0, microsecond=0)
        start = end - timedelta(days=1)
        return start, end, "Ayer"
    if p in ("week", "semana", "semanal"):
        start = now - timedelta(days=7)
        return start, now, "Última semana"
    if p in ("month", "mes", "mensual"):
        start = now - timedelta(days=30)
        return start, now, "Último mes"
    # Por defecto: hoy
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return start, now, "Hoy"


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
    """Motor PDF paramétrico (Coord = todos / Esp = propios / Sub = scope)."""
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

    # --- Query de reportes ---------------------------------------------------
    # RBAC ESTRICTO:
    #   - Coordinador General: acceso global (sin filtro por usuario).
    #   - Cualquier otro rol (Especialista, Sub-Coordinador, Analyst, etc.):
    #     filtro OBLIGATORIO por captured_by == user.id para que solo descargue
    #     sus propios reportes. Esto blinda el endpoint contra fugas de datos
    #     entre usuarios y permite que specialist/analyst usen "Mis Reportes".
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

    # --- Resolución de rutas (cache) ----------------------------------------
    path_cache: dict = {}
    async def _path(nid: str) -> str:
        if nid in path_cache:
            return path_cache[nid]
        names = await node_path_names(nid)
        s = " › ".join(names)
        path_cache[nid] = s
        return s

    # Pre-cargar rutas de nodos con reportes
    for nid in list(reports_by_node.keys()):
        await _path(nid)

    # --- Generar PDF ---------------------------------------------------------
    buf = io.BytesIO()
    PAGE = landscape(A4)  # 29.7 x 21 cm
    PW, PH = PAGE
    c = _canvas.Canvas(buf, pagesize=PAGE)

    BRAND = HexColor("#1E3A8A")
    MUTED = HexColor("#64748B")
    BORDER = HexColor("#E2E8F0")
    TEXT = HexColor("#0F172A")

    def draw_header(page_num: int):
        # Logo
        if LOGO_PATH.exists():
            try:
                logo = ImageReader(str(LOGO_PATH))
                # Logo Dirac (~2.73:1). Caja ajustada al ratio nativo + preserveAspectRatio.
                c.drawImage(logo, 1.2 * cm, PH - 1.9 * cm, width=3.0 * cm, height=1.2 * cm,
                            preserveAspectRatio=True, mask='auto')
            except Exception:
                pass
        c.setFillColor(BRAND)
        c.setFont("Helvetica-Bold", 11)
        c.drawString(4.0 * cm, PH - 1.2 * cm, f"SynCo · {proj.get('name','')}")
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 8)
        c.drawString(4.0 * cm, PH - 1.6 * cm, f"Reporte {period_label} · Exportado {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
        # Línea inferior
        c.setStrokeColor(BORDER)
        c.setLineWidth(0.5)
        c.line(1.2 * cm, PH - 2.0 * cm, PW - 1.2 * cm, PH - 2.0 * cm)
        # Pie
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 7)
        c.drawRightString(PW - 1.2 * cm, 0.8 * cm, f"Página {page_num}")

    # --- PORTADA -------------------------------------------------------------
    page_num = 1
    # Sin header de página en la portada
    if LOGO_PATH.exists():
        try:
            logo = ImageReader(str(LOGO_PATH))
            # Portada: caja 8x3cm (ratio 2.67) compatible con logo Dirac nativo (~2.73:1).
            c.drawImage(logo, (PW - 8 * cm) / 2, PH - 6.5 * cm, width=8 * cm, height=3 * cm,
                        preserveAspectRatio=True, mask='auto')
        except Exception:
            pass
    c.setFillColor(BRAND)
    c.setFont("Helvetica-Bold", 28)
    c.drawCentredString(PW / 2, PH - 8.5 * cm, "Reporte de Avance")
    c.setFillColor(TEXT)
    c.setFont("Helvetica-Bold", 18)
    c.drawCentredString(PW / 2, PH - 9.8 * cm, proj.get("name", "Proyecto"))
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 12)
    c.drawCentredString(PW / 2, PH - 11.2 * cm, f"Período: {period_label}")
    c.drawCentredString(PW / 2, PH - 12.0 * cm,
                        f"{start_dt.strftime('%Y-%m-%d %H:%M')} – {end_dt.strftime('%Y-%m-%d %H:%M')} UTC")
    c.setFont("Helvetica-Bold", 11)
    c.setFillColor(TEXT)
    label_author = "Coordinador" if role == ROLE_COORD else ("Especialista" if role == ROLE_ESPECIALISTA else "Sub-Coordinador")
    c.drawCentredString(PW / 2, PH - 13.5 * cm, f"{label_author}: {user.get('name','')}")
    c.setFont("Helvetica", 10)
    c.setFillColor(MUTED)
    c.drawCentredString(PW / 2, PH - 14.2 * cm, user.get("email", ""))
    # Resumen
    total_reportes = sum(len(v) for v in reports_by_node.values())
    c.drawCentredString(PW / 2, PH - 15.5 * cm, f"Total de reportes incluidos: {total_reportes}")
    # Pie portada
    c.setFont("Helvetica", 7)
    c.drawRightString(PW - 1.2 * cm, 0.8 * cm, f"Página {page_num}")
    c.showPage()
    page_num += 1

    # --- Si no hay reportes, agregamos una página vacía informativa ----------
    if total_reportes == 0:
        draw_header(page_num)
        c.setFillColor(MUTED)
        c.setFont("Helvetica-Oblique", 14)
        c.drawCentredString(PW / 2, PH / 2, "No hay reportes para el período seleccionado.")
        c.showPage()
        c.save()
        buf.seek(0)
        safe_name = re.sub(r"[^A-Za-z0-9_-]+", "_", proj.get("name", "proyecto"))[:60] or "proyecto"
        fname = f"synco_{safe_name}_{period}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M')}.pdf"
        return StreamingResponse(buf, media_type="application/pdf",
                                 headers={"Content-Disposition": f'attachment; filename="{fname}"'})

    # --- CUERPO: una página por reporte (orden jerárquico) -------------------
    PHOTO_W = 10.0 * cm
    PHOTO_H = 13.37 * cm

    def render_text_block(x: float, y: float, max_w: float, lines: list, font="Helvetica", size=9, leading=12):
        c.setFont(font, size)
        c.setFillColor(TEXT)
        cy = y
        for ln in lines:
            if cy < 1.5 * cm:
                break
            # wrap simple por ancho de pixel
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

    def fmt_coord(v) -> str:
        if v is None or v == "":
            return "—"
        try:
            return f"{float(v):.6f}"
        except Exception:
            return str(v)

    for n in leaf_nodes:
        node_reps = reports_by_node.get(n["id"]) or []
        if not node_reps:
            continue
        node_path = path_cache.get(n["id"]) or n.get("name", "")
        target_lat = n.get("target_lat")
        target_lon = n.get("target_lon")
        target_elev = n.get("target_elev")
        for r in node_reps:
            draw_header(page_num)

            # === Foto centrada 10 x 13.37 cm =================================
            photo_x = (PW - PHOTO_W) / 2
            photo_y = PH - 2.3 * cm - PHOTO_H  # debajo del header
            # Marco
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

            # === Bloque de datos a la derecha de la foto =====================
            data_x = photo_x + PHOTO_W + 0.8 * cm
            data_w = PW - data_x - 1.2 * cm
            cy = PH - 2.6 * cm

            c.setFillColor(BRAND)
            c.setFont("Helvetica-Bold", 10)
            c.drawString(data_x, cy, "RUTA")
            cy -= 0.45 * cm
            cy = render_text_block(data_x, cy, data_w, [node_path], font="Helvetica-Bold", size=10, leading=13)

            cy -= 0.25 * cm
            c.setFillColor(BRAND)
            c.setFont("Helvetica-Bold", 10)
            c.drawString(data_x, cy, "COORDENADAS OBJETIVO (X, Y, Z)")
            cy -= 0.45 * cm
            coord_str = f"X (Lat): {fmt_coord(target_lat)}    Y (Lon): {fmt_coord(target_lon)}    Z (Elev): {fmt_coord(target_elev)}"
            cy = render_text_block(data_x, cy, data_w, [coord_str], size=9.5, leading=12)

            cy -= 0.25 * cm
            c.setFillColor(BRAND)
            c.setFont("Helvetica-Bold", 10)
            c.drawString(data_x, cy, "AVANCE")
            cy -= 0.45 * cm
            avance = r.get("avance") or "—"
            cy = render_text_block(data_x, cy, data_w, [str(avance)], size=10, leading=13)

            cy -= 0.25 * cm
            c.setFillColor(BRAND)
            c.setFont("Helvetica-Bold", 10)
            c.drawString(data_x, cy, "OBSERVACIONES")
            cy -= 0.45 * cm
            notes = r.get("notes") or "—"
            cy = render_text_block(data_x, cy, data_w, [str(notes)], size=9.5, leading=12)

            # === Pie del reporte: capturado por + fecha ======================
            captured_by = r.get("captured_by_name") or "—"
            ts = r.get("created_at")
            ts_str = ts.strftime("%Y-%m-%d %H:%M UTC") if isinstance(ts, datetime) else ""
            c.setFillColor(MUTED)
            c.setFont("Helvetica-Oblique", 8)
            c.drawString(photo_x, photo_y - 0.5 * cm, f"Capturado por: {captured_by}  ·  {ts_str}")

            c.showPage()
            page_num += 1

    c.save()
    buf.seek(0)
    safe_name = re.sub(r"[^A-Za-z0-9_-]+", "_", proj.get("name", "proyecto"))[:60] or "proyecto"
    fname = f"synco_{safe_name}_{period}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M')}.pdf"
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
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
