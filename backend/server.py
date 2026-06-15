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
import uuid
import logging
import secrets
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
COLLECTIONS_V2 = ["users", "projects", "location_nodes", "areas", "invitations", "reports"]

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


class LocationNodeOut(BaseModel):
    id: str
    project_id: str
    parent_id: Optional[str] = None
    name: str
    depth: int
    order: int
    is_leaf: bool
    measurement_type: Optional[str] = None
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
                {"$set": {"is_leaf": False, "measurement_type": None}},
            )
    if body.is_leaf and body.measurement_type not in MEASUREMENT_TYPES:
        raise HTTPException(400, "Nodos hoja requieren measurement_type válido")
    nid = str(uuid.uuid4())
    doc = {
        "id": nid,
        "project_id": pid,
        "parent_id": body.parent_id,
        "name": body.name.strip(),
        "depth": depth,
        "order": body.order,
        "is_leaf": body.is_leaf,
        "measurement_type": body.measurement_type if body.is_leaf else None,
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
    elif body.measurement_type is not None:
        if not node.get("is_leaf"):
            raise HTTPException(400, "measurement_type solo aplica a hojas")
        if body.measurement_type not in MEASUREMENT_TYPES:
            raise HTTPException(400, "measurement_type inválido")
        upd["measurement_type"] = body.measurement_type
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
    if inv["expires_at"].replace(tzinfo=timezone.utc) if inv["expires_at"].tzinfo is None else inv["expires_at"] < datetime.now(timezone.utc):
        raise HTTPException(410, "Invitación expirada")
    inv.pop("_id", None)
    return {
        "project_name": inv["project_name"],
        "email": inv["email"],
        "name": inv["name"],
        "role": inv["role"],
        "puesto": inv.get("puesto"),
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
        "area_id": body.area_id or user.get("area_id"),
        "area_name": area_name,
        "notes": (body.notes or "").strip() or None,
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
async def list_project_users(pid: str, user: dict = Depends(require_role(ROLE_COORD))):
    await ensure_project_access(user, pid)
    items = await db.users.find({"project_ids": pid}).to_list(length=1000)
    return [user_to_out(u) for u in items]


# === MOUNT ==================================================================
app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
