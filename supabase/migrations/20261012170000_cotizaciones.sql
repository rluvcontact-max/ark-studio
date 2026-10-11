-- Cotizaciones inteligentes (Prompt maestro de cotizaciones v1.0).
-- El precio lo calcula un motor determinista en código (web/cotizador.js = supabase/functions/cotizacion/cotizador.js)
-- con el tarifario guardado aquí; Claude solo redacta propuesta, guion y presentación con esa cotización.
--   tarifarios         : cada edición del admin es una versión nueva (las cotizaciones guardan con qué versión se hicieron).
--   cotizaciones       : versiones inmutables de la cotización de cada cliente (las escribe solo la Edge Function cotizacion).
--   cotizacion_costos  : costo directo validado por el admin (piso técnico y margen); solo admin.

create table public.tarifarios (
  version int primary key,
  data jsonb not null,
  nota text not null default '',
  autor uuid default auth.uid(),
  creado timestamptz not null default now()
);
alter table public.tarifarios enable row level security;
-- todo el equipo lo lee (el panel recalcula en vivo); solo se escribe con la RPC guardar_tarifario
create policy tarifarios_select on public.tarifarios for select to authenticated using (true);

create table public.cotizaciones (
  id text primary key,                 -- <clienteId>:<version>
  cliente_id text not null references public.clientes(id) on delete cascade,
  version int not null,
  data jsonb not null,
  autor uuid,
  creado timestamptz not null default now(),
  unique (cliente_id, version)
);
create index cotizaciones_cliente on public.cotizaciones (cliente_id);
alter table public.cotizaciones enable row level security;
-- el admin y el vendedor del cliente la leen; nadie la escribe desde el navegador (solo la Edge Function con service role)
create policy cotizaciones_select on public.cotizaciones for select to authenticated
  using (public.es_admin() or exists (select 1 from public.clientes c where c.id = cliente_id and c.empleado_id = public.mi_empleado()));

create table public.cotizacion_costos (
  id text primary key,                 -- id de la cotización
  cliente_id text not null references public.clientes(id) on delete cascade,
  data jsonb not null,                 -- {cd, alcance, margen, por, fecha}
  creado timestamptz not null default now()
);
alter table public.cotizacion_costos enable row level security;
create policy cotizacion_costos_admin on public.cotizacion_costos for select to authenticated using (public.es_admin());

-- Editar tarifas y porcentajes sin tocar código: cada guardado crea una versión nueva.
create or replace function public.guardar_tarifario(p_data jsonb, p_nota text default '')
returns int language plpgsql security definer set search_path = public as $$
declare v int;
begin
  if not public.es_admin() then raise exception 'Solo el administrador puede editar el tarifario' using errcode = '42501'; end if;
  if jsonb_typeof(p_data->'industrias') is distinct from 'array' or jsonb_array_length(p_data->'industrias') = 0 then
    raise exception 'El tarifario debe tener al menos una industria';
  end if;
  if jsonb_typeof(p_data->'politica') is distinct from 'object' then raise exception 'Falta la política de oferta y negociación'; end if;
  perform pg_advisory_xact_lock(hashtext('tarifarios'));
  select coalesce(max(version), 0) + 1 into v from public.tarifarios;
  insert into public.tarifarios (version, data, nota, autor) values (v, p_data, coalesce(p_nota, ''), auth.uid());
  return v;
end $$;
revoke all on function public.guardar_tarifario(jsonb, text) from public, anon;
grant execute on function public.guardar_tarifario(jsonb, text) to authenticated;

-- Tarifario inicial (supabase/tarifario/tarifario-v1.json). En producción se insertó aparte con el mismo contenido (md5 verificado).
insert into public.tarifarios (version, data, nota, autor)
values (1, $tar${
 "nombre": "Tarifario inicial (Prompt maestro de cotizaciones v1.0)",
 "moneda": "MXN",
 "redondeo": 1,
 "niveles": {
  "basico": {
   "nombre": "Básico",
   "factor": 0.7
  },
  "intermedio": {
   "nombre": "Intermedio",
   "factor": 1
  },
  "avanzado": {
   "nombre": "Avanzado",
   "factor": 1.5
  },
  "empresarial": {
   "nombre": "Empresarial",
   "factor": 2,
   "desde": true,
   "revision": true
  }
 },
 "base_incluye": "App web responsiva sencilla, una sede, pantallas informativas, identidad visual estándar, navegación, contacto/WhatsApp por enlace y pruebas básicas.",
 "base_no_incluye": "Autenticación, transacciones, inventarios, integraciones complejas, versión nativa iOS/Android, costos de terceros ni mantenimiento.",
 "industrias": [
  {
   "id": "belleza",
   "nombre": "Belleza, spas y barberías",
   "base": 12000,
   "minimo": 15000,
   "admin": "bel.admin",
   "modulos": [
    {
     "id": "bel.catalogo",
     "nombre": "Catálogo de servicios",
     "precio": 2500
    },
    {
     "id": "bel.reservas",
     "nombre": "Reservaciones de citas",
     "precio": 5000,
     "niveles": true,
     "alcance": "reservas",
     "admin": true,
     "incluye": [
      "bel.calendario"
     ]
    },
    {
     "id": "bel.especialistas",
     "nombre": "Selección de especialistas",
     "precio": 3000,
     "requiere": [
      "bel.reservas"
     ]
    },
    {
     "id": "bel.calendario",
     "nombre": "Calendario de disponibilidad",
     "precio": 3500,
     "admin": true
    },
    {
     "id": "bel.pagos",
     "nombre": "Pagos anticipados",
     "precio": 5000,
     "niveles": true,
     "alcance": "pagos",
     "admin": true,
     "comparte": "pagos"
    },
    {
     "id": "bel.recordatorios",
     "nombre": "Recordatorios automáticos",
     "precio": 3000,
     "comparte": "recordatorios"
    },
    {
     "id": "bel.lealtad",
     "nombre": "Programa de lealtad",
     "precio": 5000,
     "niveles": true,
     "alcance": "lealtad",
     "admin": true,
     "requiere": [
      "tr.login"
     ]
    },
    {
     "id": "bel.promos",
     "nombre": "Promociones y descuentos",
     "precio": 3000,
     "comparte": "cupones"
    },
    {
     "id": "bel.resenas",
     "nombre": "Reseñas de especialistas",
     "precio": 3000,
     "comparte": "resenas"
    },
    {
     "id": "bel.galeria",
     "nombre": "Galería de trabajos",
     "precio": 2000
    },
    {
     "id": "bel.historial",
     "nombre": "Historial de visitas",
     "precio": 3500,
     "requiere": [
      "tr.login"
     ]
    },
    {
     "id": "bel.productos",
     "nombre": "Venta de productos",
     "precio": 6000,
     "niveles": true,
     "alcance": "pedidos",
     "admin": true
    },
    {
     "id": "bel.admin",
     "nombre": "Panel administrativo",
     "precio": 6000,
     "comparte": "admin"
    },
    {
     "id": "bel.empleados",
     "nombre": "Administración de empleados",
     "precio": 5000,
     "comparte": "empleados"
    },
    {
     "id": "bel.sucursales",
     "nombre": "Múltiples sucursales",
     "precio": 8000,
     "desde": true,
     "comparte": "multisucursal"
    }
   ]
  },
  {
   "id": "restaurantes",
   "nombre": "Restaurantes y cafeterías",
   "base": 12000,
   "minimo": 15000,
   "admin": "res.panel_pedidos",
   "modulos": [
    {
     "id": "res.menu",
     "nombre": "Menú digital",
     "precio": 3000
    },
    {
     "id": "res.recoger",
     "nombre": "Pedidos para recoger",
     "precio": 6000,
     "niveles": true,
     "alcance": "pedidos",
     "admin": true
    },
    {
     "id": "res.domicilio",
     "nombre": "Pedidos a domicilio",
     "precio": 10000,
     "niveles": true,
     "alcance": "pedidos",
     "admin": true,
     "incluye": [
      "res.recoger"
     ]
    },
    {
     "id": "res.pagos",
     "nombre": "Pagos en línea",
     "precio": 5000,
     "niveles": true,
     "alcance": "pagos",
     "admin": true,
     "comparte": "pagos"
    },
    {
     "id": "res.reservas",
     "nombre": "Reservaciones de mesas",
     "precio": 5000,
     "niveles": true,
     "alcance": "reservas",
     "admin": "res.mesas"
    },
    {
     "id": "res.mesas",
     "nombre": "Administración de mesas",
     "precio": 6000
    },
    {
     "id": "res.qr",
     "nombre": "Pedidos mediante QR",
     "precio": 6000,
     "niveles": true,
     "alcance": "pedidos",
     "admin": true
    },
    {
     "id": "res.recompensas",
     "nombre": "Programa de recompensas",
     "precio": 5000,
     "niveles": true,
     "alcance": "lealtad",
     "admin": true,
     "requiere": [
      "tr.login"
     ]
    },
    {
     "id": "res.cupones",
     "nombre": "Cupones y promociones",
     "precio": 3000,
     "comparte": "cupones"
    },
    {
     "id": "res.resenas",
     "nombre": "Reseñas de clientes",
     "precio": 2500,
     "comparte": "resenas"
    },
    {
     "id": "res.notificaciones",
     "nombre": "Notificaciones",
     "precio": 3000,
     "comparte": "notificaciones"
    },
    {
     "id": "res.panel_pedidos",
     "nombre": "Panel de pedidos",
     "precio": 8000,
     "comparte": "admin"
    },
    {
     "id": "res.estadisticas",
     "nombre": "Estadísticas de ventas",
     "precio": 6000,
     "comparte": "estadisticas"
    },
    {
     "id": "res.sucursales",
     "nombre": "Múltiples sucursales",
     "precio": 10000,
     "desde": true,
     "comparte": "multisucursal"
    }
   ]
  },
  {
   "id": "tiendas",
   "nombre": "Tiendas y comercios",
   "base": 12000,
   "minimo": 15000,
   "admin": "tie.admin",
   "modulos": [
    {
     "id": "tie.catalogo",
     "nombre": "Catálogo de productos",
     "precio": 4000
    },
    {
     "id": "tie.carrito",
     "nombre": "Carrito de compras",
     "precio": 5000,
     "niveles": true,
     "alcance": "pedidos",
     "admin": true
    },
    {
     "id": "tie.pagos",
     "nombre": "Pagos en línea",
     "precio": 5500,
     "niveles": true,
     "alcance": "pagos",
     "admin": true,
     "comparte": "pagos"
    },
    {
     "id": "tie.inventario",
     "nombre": "Gestión de inventario",
     "precio": 8000,
     "niveles": true,
     "alcance": "inventario",
     "admin": true
    },
    {
     "id": "tie.seguimiento",
     "nombre": "Seguimiento de pedidos",
     "precio": 7000,
     "niveles": true,
     "alcance": "entregas",
     "admin": true
    },
    {
     "id": "tie.favoritos",
     "nombre": "Lista de favoritos",
     "precio": 2000,
     "requiere": [
      "tr.login"
     ]
    },
    {
     "id": "tie.buscador",
     "nombre": "Buscador de productos",
     "precio": 3000,
     "comparte": "buscador"
    },
    {
     "id": "tie.cupones",
     "nombre": "Cupones y descuentos",
     "precio": 3000,
     "comparte": "cupones"
    },
    {
     "id": "tie.resenas",
     "nombre": "Reseñas de productos",
     "precio": 3000,
     "comparte": "resenas"
    },
    {
     "id": "tie.cuentas",
     "nombre": "Cuentas de clientes",
     "precio": 3000,
     "incluye": [
      "tr.login",
      "tr.perfil"
     ]
    },
    {
     "id": "tie.notificaciones",
     "nombre": "Notificaciones",
     "precio": 3000,
     "comparte": "notificaciones"
    },
    {
     "id": "tie.estadisticas",
     "nombre": "Estadísticas de ventas",
     "precio": 6000,
     "comparte": "estadisticas"
    },
    {
     "id": "tie.admin",
     "nombre": "Panel administrativo",
     "precio": 7000,
     "comparte": "admin"
    },
    {
     "id": "tie.integracion_tienda",
     "nombre": "Integración con tienda existente",
     "precio": 10000,
     "desde": true
    },
    {
     "id": "tie.sucursales",
     "nombre": "Múltiples sucursales",
     "precio": 8000,
     "desde": true,
     "comparte": "multisucursal"
    }
   ]
  },
  {
   "id": "gimnasios",
   "nombre": "Gimnasios y deportes",
   "base": 20000,
   "minimo": 20000,
   "estricto": true,
   "admin": "gym.admin",
   "modulos": [
    {
     "id": "gym.planes",
     "nombre": "Planes de entrenamiento",
     "precio": 6000,
     "admin": true
    },
    {
     "id": "gym.clases",
     "nombre": "Reservación de clases",
     "precio": 6000,
     "niveles": true,
     "alcance": "reservas",
     "admin": true,
     "incluye": [
      "gym.horarios"
     ]
    },
    {
     "id": "gym.membresias",
     "nombre": "Pago de membresías",
     "precio": 8000,
     "niveles": true,
     "alcance": "membresias",
     "admin": true,
     "comparte": "pagos"
    },
    {
     "id": "gym.qr",
     "nombre": "Membresía digital con QR",
     "precio": 6000,
     "admin": true,
     "requiere": [
      "tr.login"
     ]
    },
    {
     "id": "gym.entrenadores",
     "nombre": "Perfiles de entrenadores",
     "precio": 3000
    },
    {
     "id": "gym.sesiones",
     "nombre": "Reservación de sesiones personales",
     "precio": 5000,
     "niveles": true,
     "alcance": "reservas",
     "admin": true
    },
    {
     "id": "gym.progreso",
     "nombre": "Seguimiento del progreso",
     "precio": 7000,
     "requiere": [
      "tr.login"
     ]
    },
    {
     "id": "gym.retos",
     "nombre": "Retos y logros",
     "precio": 6000,
     "niveles": true,
     "alcance": "lealtad",
     "requiere": [
      "tr.login"
     ]
    },
    {
     "id": "gym.notificaciones",
     "nombre": "Notificaciones",
     "precio": 3000,
     "comparte": "notificaciones"
    },
    {
     "id": "gym.horarios",
     "nombre": "Horarios de clases",
     "precio": 2000
    },
    {
     "id": "gym.alimentacion",
     "nombre": "Planes alimenticios informativos",
     "precio": 4500
    },
    {
     "id": "gym.resenas",
     "nombre": "Reseñas de entrenadores",
     "precio": 3000,
     "comparte": "resenas"
    },
    {
     "id": "gym.admin",
     "nombre": "Panel administrativo",
     "precio": 9000,
     "comparte": "admin"
    },
    {
     "id": "gym.sucursales",
     "nombre": "Múltiples sucursales",
     "precio": 12000,
     "desde": true,
     "comparte": "multisucursal"
    },
    {
     "id": "gym.comunidad",
     "nombre": "Comunidad de miembros",
     "precio": 8000,
     "requiere": [
      "tr.login"
     ]
    }
   ]
  },
  {
   "id": "educacion",
   "nombre": "Educación y academias",
   "base": 18000,
   "minimo": 20000,
   "admin": "edu.admin",
   "modulos": [
    {
     "id": "edu.catalogo",
     "nombre": "Catálogo de cursos",
     "precio": 3000
    },
    {
     "id": "edu.estudiantes",
     "nombre": "Perfiles de estudiantes",
     "precio": 5000,
     "admin": true,
     "incluye": [
      "tr.login",
      "tr.perfil"
     ]
    },
    {
     "id": "edu.calendario",
     "nombre": "Calendario de clases",
     "precio": 4000
    },
    {
     "id": "edu.videos",
     "nombre": "Biblioteca de videos",
     "precio": 7000,
     "niveles": true,
     "alcance": "cursos",
     "admin": true
    },
    {
     "id": "edu.tareas",
     "nombre": "Tareas y actividades",
     "precio": 8000,
     "admin": true,
     "requiere": [
      "edu.estudiantes"
     ]
    },
    {
     "id": "edu.examenes",
     "nombre": "Exámenes y cuestionarios",
     "precio": 9000,
     "admin": true,
     "requiere": [
      "edu.estudiantes"
     ]
    },
    {
     "id": "edu.seguimiento",
     "nombre": "Seguimiento académico",
     "precio": 8000,
     "admin": true,
     "requiere": [
      "edu.estudiantes"
     ]
    },
    {
     "id": "edu.pagos",
     "nombre": "Pagos de cursos",
     "precio": 6000,
     "niveles": true,
     "alcance": "pagos",
     "admin": true,
     "comparte": "pagos"
    },
    {
     "id": "edu.certificados",
     "nombre": "Certificados digitales",
     "precio": 5000
    },
    {
     "id": "edu.notificaciones",
     "nombre": "Notificaciones",
     "precio": 3000,
     "comparte": "notificaciones"
    },
    {
     "id": "edu.profesores",
     "nombre": "Perfiles de profesores",
     "precio": 4000
    },
    {
     "id": "edu.asistencia",
     "nombre": "Control de asistencia",
     "precio": 5000,
     "admin": true
    },
    {
     "id": "edu.comunicacion",
     "nombre": "Comunicación con profesores",
     "precio": 7000,
     "niveles": true,
     "alcance": "chat",
     "comparte": "chat"
    },
    {
     "id": "edu.admin",
     "nombre": "Panel administrativo",
     "precio": 10000,
     "comparte": "admin"
    }
   ]
  },
  {
   "id": "empresas",
   "nombre": "Empresas y servicios profesionales",
   "base": 18000,
   "minimo": 20000,
   "admin": "emp.admin",
   "modulos": [
    {
     "id": "emp.catalogo",
     "nombre": "Catálogo de servicios",
     "precio": 3000
    },
    {
     "id": "emp.agenda",
     "nombre": "Agenda de citas",
     "precio": 5000,
     "niveles": true,
     "alcance": "reservas",
     "admin": true
    },
    {
     "id": "emp.portal",
     "nombre": "Portal de clientes",
     "precio": 8000,
     "admin": true,
     "incluye": [
      "tr.login",
      "tr.perfil"
     ]
    },
    {
     "id": "emp.documentos",
     "nombre": "Gestión de documentos",
     "precio": 8000,
     "admin": true,
     "comparte": "archivos"
    },
    {
     "id": "emp.proyectos",
     "nombre": "Seguimiento de proyectos",
     "precio": 10000,
     "admin": true
    },
    {
     "id": "emp.pagos",
     "nombre": "Pagos en línea",
     "precio": 6000,
     "niveles": true,
     "alcance": "pagos",
     "admin": true,
     "comparte": "pagos"
    },
    {
     "id": "emp.cotizaciones",
     "nombre": "Generación de cotizaciones",
     "precio": 7000,
     "admin": true
    },
    {
     "id": "emp.firma",
     "nombre": "Firma electrónica simple",
     "precio": 7000
    },
    {
     "id": "emp.chat",
     "nombre": "Chat con clientes",
     "precio": 7000,
     "niveles": true,
     "alcance": "chat",
     "comparte": "chat"
    },
    {
     "id": "emp.notificaciones",
     "nombre": "Notificaciones",
     "precio": 3000,
     "comparte": "notificaciones"
    },
    {
     "id": "emp.empleados",
     "nombre": "Administración de empleados",
     "precio": 7000,
     "comparte": "empleados"
    },
    {
     "id": "emp.admin",
     "nombre": "Panel administrativo",
     "precio": 10000,
     "comparte": "admin"
    },
    {
     "id": "emp.reportes",
     "nombre": "Reportes de actividad",
     "precio": 6000,
     "comparte": "estadisticas"
    },
    {
     "id": "emp.crm",
     "nombre": "Integración con CRM",
     "precio": 12000,
     "desde": true,
     "comparte": "crm"
    }
   ]
  },
  {
   "id": "hoteles",
   "nombre": "Hoteles y hospedaje",
   "base": 22000,
   "minimo": 25000,
   "admin": "hot.admin",
   "modulos": [
    {
     "id": "hot.catalogo",
     "nombre": "Catálogo de habitaciones",
     "precio": 5000
    },
    {
     "id": "hot.reservas",
     "nombre": "Reservaciones",
     "precio": 9000,
     "niveles": true,
     "alcance": "reservas",
     "admin": true
    },
    {
     "id": "hot.pagos",
     "nombre": "Pagos en línea",
     "precio": 6000,
     "niveles": true,
     "alcance": "pagos",
     "admin": true,
     "comparte": "pagos"
    },
    {
     "id": "hot.calendario",
     "nombre": "Calendario de disponibilidad",
     "precio": 6000,
     "admin": true
    },
    {
     "id": "hot.confirmaciones",
     "nombre": "Confirmaciones automáticas",
     "precio": 3500,
     "comparte": "confirmaciones"
    },
    {
     "id": "hot.room_service",
     "nombre": "Servicio a habitación",
     "precio": 7000,
     "admin": true
    },
    {
     "id": "hot.restaurante",
     "nombre": "Pedidos de restaurante",
     "precio": 8000,
     "niveles": true,
     "alcance": "pedidos",
     "admin": true
    },
    {
     "id": "hot.resenas",
     "nombre": "Reseñas de huéspedes",
     "precio": 3000,
     "comparte": "resenas"
    },
    {
     "id": "hot.fidelidad",
     "nombre": "Programa de fidelidad",
     "precio": 6000,
     "niveles": true,
     "alcance": "lealtad",
     "requiere": [
      "tr.login"
     ]
    },
    {
     "id": "hot.guia",
     "nombre": "Guía turística local",
     "precio": 3000
    },
    {
     "id": "hot.checkin",
     "nombre": "Check-in digital básico",
     "precio": 8000,
     "admin": true
    },
    {
     "id": "hot.chat",
     "nombre": "Chat con recepción",
     "precio": 7000,
     "niveles": true,
     "alcance": "chat",
     "comparte": "chat"
    },
    {
     "id": "hot.admin",
     "nombre": "Panel administrativo",
     "precio": 10000,
     "comparte": "admin"
    },
    {
     "id": "hot.propiedades",
     "nombre": "Gestión de múltiples propiedades",
     "precio": 15000,
     "desde": true,
     "comparte": "multisucursal"
    }
   ]
  },
  {
   "id": "salud",
   "nombre": "Salud y clínicas",
   "base": 22000,
   "minimo": 25000,
   "admin": "sal.admin",
   "modulos": [
    {
     "id": "sal.agenda",
     "nombre": "Agenda de citas",
     "precio": 7000,
     "niveles": true,
     "alcance": "reservas",
     "admin": true
    },
    {
     "id": "sal.directorio",
     "nombre": "Directorio de especialistas",
     "precio": 4500
    },
    {
     "id": "sal.pacientes",
     "nombre": "Perfiles de pacientes",
     "precio": 5000,
     "admin": true,
     "incluye": [
      "tr.login",
      "tr.perfil"
     ]
    },
    {
     "id": "sal.historial",
     "nombre": "Historial clínico digital",
     "precio": 18000,
     "desde": true,
     "niveles": true,
     "alcance": "expediente",
     "revision": true,
     "admin": true,
     "requiere": [
      "sal.pacientes"
     ],
     "nota": "Datos de salud: requiere revisión técnica, de privacidad, seguridad y legal."
    },
    {
     "id": "sal.recordatorios",
     "nombre": "Recordatorios de citas",
     "precio": 3500,
     "comparte": "recordatorios"
    },
    {
     "id": "sal.pagos",
     "nombre": "Pagos de consultas",
     "precio": 6000,
     "niveles": true,
     "alcance": "pagos",
     "admin": true,
     "comparte": "pagos"
    },
    {
     "id": "sal.formularios",
     "nombre": "Formularios previos a consulta",
     "precio": 5000,
     "comparte": "formularios"
    },
    {
     "id": "sal.documentos",
     "nombre": "Documentos y resultados médicos",
     "precio": 10000,
     "desde": true,
     "niveles": true,
     "alcance": "expediente",
     "revision": true,
     "admin": true,
     "requiere": [
      "sal.pacientes"
     ],
     "comparte": "archivos",
     "nota": "Datos de salud: requiere revisión técnica, de privacidad, seguridad y legal."
    },
    {
     "id": "sal.mensajeria",
     "nombre": "Mensajería paciente-clínica",
     "precio": 9000,
     "comparte": "chat"
    },
    {
     "id": "sal.video",
     "nombre": "Videoconsultas",
     "precio": 18000,
     "desde": true,
     "revision": true,
     "requiere": [
      "sal.agenda"
     ],
     "nota": "Videoconsulta: requiere revisión técnica, de privacidad y legal."
    },
    {
     "id": "sal.admin",
     "nombre": "Panel administrativo",
     "precio": 10000,
     "comparte": "admin"
    },
    {
     "id": "sal.especialistas",
     "nombre": "Administración de especialistas",
     "precio": 7000,
     "comparte": "empleados"
    },
    {
     "id": "sal.sucursales",
     "nombre": "Gestión de sucursales",
     "precio": 10000,
     "desde": true,
     "comparte": "multisucursal"
    },
    {
     "id": "sal.accesos",
     "nombre": "Controles avanzados de acceso",
     "precio": 12000,
     "desde": true,
     "revision": true
    }
   ]
  }
 ],
 "transversales": [
  {
   "id": "tr.login",
   "nombre": "Registro e inicio de sesión",
   "precio": 3000,
   "comparte": "login"
  },
  {
   "id": "tr.social",
   "nombre": "Inicio de sesión con Google/Apple",
   "precio": 2500,
   "requiere": [
    "tr.login"
   ]
  },
  {
   "id": "tr.perfil",
   "nombre": "Perfil de usuario",
   "precio": 3000,
   "requiere": [
    "tr.login"
   ]
  },
  {
   "id": "tr.push",
   "nombre": "Notificaciones push",
   "precio": 3000,
   "comparte": "notificaciones"
  },
  {
   "id": "tr.buscador",
   "nombre": "Buscador personalizado",
   "precio": 3000,
   "comparte": "buscador"
  },
  {
   "id": "tr.formularios",
   "nombre": "Formularios personalizados",
   "precio": 2500,
   "comparte": "formularios"
  },
  {
   "id": "tr.chat",
   "nombre": "Chat entre usuarios",
   "precio": 7000,
   "desde": true,
   "comparte": "chat"
  },
  {
   "id": "tr.bot_basico",
   "nombre": "Chatbot IA básico",
   "precio": 8000,
   "desde": true,
   "comparte": "chatbot"
  },
  {
   "id": "tr.bot_personalizado",
   "nombre": "Chatbot IA personalizado",
   "precio": 15000,
   "desde": true,
   "comparte": "chatbot"
  },
  {
   "id": "tr.bot_avanzado",
   "nombre": "Chatbot IA avanzado con integraciones",
   "precio": 30000,
   "desde": true,
   "revision": true,
   "comparte": "chatbot"
  },
  {
   "id": "tr.estadisticas",
   "nombre": "Estadísticas avanzadas",
   "precio": 12000,
   "desde": true
  },
  {
   "id": "tr.automatizacion",
   "nombre": "Automatización personalizada",
   "precio": 10000,
   "desde": true
  },
  {
   "id": "tr.archivos",
   "nombre": "Gestión de archivos y documentos",
   "precio": 8000,
   "desde": true,
   "comparte": "archivos"
  },
  {
   "id": "tr.idiomas",
   "nombre": "Idiomas adicionales",
   "precio": 3000,
   "desde": true
  }
 ],
 "integraciones": [
  {
   "id": "int.whatsapp_link",
   "nombre": "WhatsApp por enlace",
   "precio": 0
  },
  {
   "id": "int.whatsapp_api",
   "nombre": "WhatsApp Business API",
   "precio": 7000,
   "desde": true
  },
  {
   "id": "int.maps",
   "nombre": "Google Maps dinámico",
   "precio": 4000,
   "desde": true
  },
  {
   "id": "int.pasarela",
   "nombre": "Pasarela de pagos",
   "precio": 5000,
   "desde": true,
   "comparte": "pagos",
   "hasta": 8000
  },
  {
   "id": "int.facturacion",
   "nombre": "Facturación electrónica (CFDI)",
   "precio": 12000,
   "desde": true,
   "niveles": true,
   "alcance": "facturacion"
  },
  {
   "id": "int.inventario",
   "nombre": "Inventario externo",
   "precio": 12000,
   "desde": true
  },
  {
   "id": "int.pos",
   "nombre": "Punto de venta",
   "precio": 15000,
   "desde": true
  },
  {
   "id": "int.crm",
   "nombre": "CRM",
   "precio": 12000,
   "desde": true,
   "comparte": "crm"
  },
  {
   "id": "int.reservas",
   "nombre": "Reservaciones externas",
   "precio": 10000,
   "desde": true
  },
  {
   "id": "int.acceso_qr",
   "nombre": "Control de accesos QR (torniquete o lector)",
   "precio": 15000,
   "desde": true
  },
  {
   "id": "int.ia",
   "nombre": "IA externa",
   "precio": 12000,
   "desde": true
  },
  {
   "id": "int.erp",
   "nombre": "ERP",
   "precio": 0,
   "revision": true,
   "nota": "Cotización personalizada."
  }
 ],
 "automatizaciones": [
  {
   "id": "aut.confirmaciones",
   "nombre": "Confirmaciones sencillas",
   "precio": 2000,
   "comparte": "confirmaciones"
  },
  {
   "id": "aut.recordatorios",
   "nombre": "Recordatorios automáticos",
   "precio": 3000,
   "comparte": "recordatorios"
  },
  {
   "id": "aut.renovaciones",
   "nombre": "Renovaciones automáticas",
   "precio": 4000,
   "comparte": "renovaciones"
  },
  {
   "id": "aut.estados",
   "nombre": "Cambios de estado automáticos",
   "precio": 4000
  },
  {
   "id": "aut.reportes",
   "nombre": "Reportes automáticos",
   "precio": 5000
  },
  {
   "id": "aut.varios",
   "nombre": "Automatización de varios procesos",
   "precio": 12000,
   "desde": true
  },
  {
   "id": "aut.ia",
   "nombre": "Automatización con IA",
   "precio": 15000,
   "desde": true
  }
 ],
 "especiales": [
  {
   "id": "esp.firma_avanzada",
   "nombre": "Firma electrónica avanzada (como la e.firma)",
   "precio": 0,
   "revision": true
  },
  {
   "id": "esp.rutas",
   "nombre": "Optimización de rutas",
   "precio": 0,
   "revision": true
  },
  {
   "id": "esp.flotilla",
   "nombre": "Control de flotilla",
   "precio": 0,
   "revision": true
  },
  {
   "id": "esp.simulador",
   "nombre": "Simulador de crédito",
   "precio": 0,
   "revision": true
  },
  {
   "id": "esp.recorridos_360",
   "nombre": "Recorridos virtuales 360°",
   "precio": 0,
   "revision": true
  },
  {
   "id": "esp.integracion_otra",
   "nombre": "Integración con otro sistema",
   "precio": 0,
   "revision": true
  }
 ],
 "alcances": {
  "reservas": {
   "basico": "El cliente elige fecha y hora",
   "intermedio": "También elige al empleado o especialista",
   "avanzado": "Administración de horarios, empleados y disponibilidad",
   "empresarial": "Varias sucursales, cada una con su personal"
  },
  "pedidos": {
   "basico": "Recibir solicitudes de pedido",
   "intermedio": "Pedidos con pago en línea",
   "avanzado": "Estados del pedido, notificaciones y seguimiento",
   "empresarial": "Conectado con inventario, sucursales o sistemas actuales"
  },
  "pagos": {
   "basico": "Pagos únicos",
   "intermedio": "Anticipos o depósitos",
   "avanzado": "Pagos recurrentes, a plazos o con varios métodos",
   "empresarial": "Conciliación y reglas de cobro a la medida"
  },
  "membresias": {
   "basico": "Consultar membresías activas",
   "intermedio": "Pagos y renovaciones desde la app",
   "avanzado": "Cobro automático, recordatorios y varios planes",
   "empresarial": "Membresías, accesos y varias sucursales"
  },
  "inventario": {
   "basico": "Agregar y editar productos",
   "intermedio": "Existencias que se descuentan solas",
   "avanzado": "Alertas, reportes y movimientos",
   "empresarial": "Inventario sincronizado entre sucursales"
  },
  "entregas": {
   "basico": "Avisos de estatus",
   "intermedio": "App para repartidores o choferes",
   "avanzado": "Ubicación en tiempo real en el mapa",
   "empresarial": "Rutas optimizadas, flotilla y varios almacenes"
  },
  "expediente": {
   "basico": "Consulta básica de cada paciente",
   "intermedio": "Registro y actualización del historial",
   "avanzado": "Documentos, resultados y seguimiento",
   "empresarial": "Permisos por especialista y varias sucursales"
  },
  "cursos": {
   "basico": "Videos y materiales para consultar",
   "intermedio": "Lecciones con avance, tareas y exámenes",
   "avanzado": "Venta de cursos, certificados y comunidad",
   "empresarial": "Varias escuelas o plataformas conectadas"
  },
  "chat": {
   "basico": "Mensajes sencillos",
   "intermedio": "Chat en tiempo real con fotos y archivos",
   "avanzado": "Varios agentes, asignación y respuestas automáticas",
   "empresarial": "Integrado con otros canales y sistemas"
  },
  "lealtad": {
   "basico": "Sellos o puntos",
   "intermedio": "Recompensas, cupones y cumpleaños",
   "avanzado": "Niveles de cliente, retos y campañas",
   "empresarial": "Programa entre sucursales o marcas"
  },
  "facturacion": {
   "basico": "El negocio emite la factura desde el panel",
   "intermedio": "Autofactura del cliente",
   "avanzado": "Facturación automática y conectada",
   "empresarial": "Conectada con ERP o contabilidad"
  }
 },
 "diseno": [
  {
   "id": "esencial",
   "nombre": "Diseño Esencial",
   "precio": 0
  },
  {
   "id": "personalizado",
   "nombre": "Diseño Personalizado",
   "precio": 7500
  },
  {
   "id": "premium",
   "nombre": "Diseño Premium",
   "precio": 20000,
   "desde": true,
   "nota": "Con revisión si el alcance es amplio."
  }
 ],
 "plataformas": [
  {
   "id": "web",
   "nombre": "Web responsiva",
   "precio": 0
  },
  {
   "id": "pwa",
   "nombre": "Web instalable (PWA)",
   "precio": 3000
  },
  {
   "id": "ios",
   "nombre": "App iOS",
   "precio": 8000,
   "desde": true,
   "nativa": true
  },
  {
   "id": "android",
   "nombre": "App Android",
   "precio": 8000,
   "desde": true,
   "nativa": true
  },
  {
   "id": "ios_android",
   "nombre": "Apps iOS y Android",
   "precio": 12000,
   "desde": true,
   "nativa": true
  },
  {
   "id": "web_ios_android",
   "nombre": "Web + iOS + Android",
   "precio": 18000,
   "desde": true,
   "nativa": true
  }
 ],
 "sucursales": [
  {
   "id": "1",
   "nombre": "1 sucursal",
   "precio": 0
  },
  {
   "id": "2-5",
   "nombre": "2 a 5 sucursales",
   "precio": 5000
  },
  {
   "id": "6-15",
   "nombre": "6 a 15 sucursales",
   "precio": 12000
  },
  {
   "id": "16-50",
   "nombre": "16 a 50 sucursales",
   "precio": 25000,
   "desde": true
  },
  {
   "id": "50+",
   "nombre": "Más de 50 sucursales",
   "precio": 0,
   "revision": true
  }
 ],
 "usuarios": [
  {
   "id": "no_se",
   "nombre": "No lo sabe",
   "precio": 0
  },
  {
   "id": "<100",
   "nombre": "Menos de 100 al mes",
   "precio": 0
  },
  {
   "id": "100-500",
   "nombre": "100 a 500 al mes",
   "precio": 0
  },
  {
   "id": "501-2000",
   "nombre": "501 a 2,000 al mes",
   "precio": 0
  },
  {
   "id": "2001-10000",
   "nombre": "2,001 a 10,000 al mes",
   "precio": 5000,
   "desde": true,
   "opcional": true,
   "nota": "Solo si se justifican pruebas u optimizaciones adicionales."
  },
  {
   "id": "10000+",
   "nombre": "Más de 10,000 al mes",
   "precio": 0,
   "revision": true
  }
 ],
 "plazos": [
  {
   "id": "normal",
   "nombre": "Normal o flexible",
   "pct": 0
  },
  {
   "id": "prioritario",
   "nombre": "Prioritario",
   "pct": 10,
   "rango": "10–15%"
  },
  {
   "id": "urgente",
   "nombre": "Urgente",
   "pct": 20,
   "rango": "20–30%",
   "nota": "Solo si se justifica trabajo adicional y se valida que se puede."
  }
 ],
 "politica": {
  "factor_oferta": 1.18,
  "factor_piso": 0.9,
  "margen": 0.6,
  "desc_vendedor": 10,
  "desc_supervisor": 20
 },
 "mantenimiento": [
  {
   "id": "esencial",
   "nombre": "Esencial",
   "precio": 799,
   "hasta": 30000
  },
  {
   "id": "profesional",
   "nombre": "Profesional",
   "precio": 1499,
   "hasta": 80000
  },
  {
   "id": "premium",
   "nombre": "Premium",
   "precio": 2999,
   "hasta": 150000
  },
  {
   "id": "empresarial",
   "nombre": "Empresarial",
   "precio": 5000,
   "desde": true
  }
 ],
 "mantenimiento_nota": "Alcance contractual limitado: no incluye desarrollos nuevos ni consumos de servicios externos.",
 "externos": [
  {
   "id": "hosting",
   "nombre": "Hosting y base de datos",
   "cuando": [
    "*"
   ]
  },
  {
   "id": "dominio",
   "nombre": "Dominio",
   "cuando": [
    "*"
   ]
  },
  {
   "id": "tiendas",
   "nombre": "Cuentas de desarrollador y publicación en App Store y Google Play",
   "cuando": [
    "nativa"
   ]
  },
  {
   "id": "pagos",
   "nombre": "Comisiones de la pasarela de pagos",
   "cuando": [
    "comparte:pagos"
   ]
  },
  {
   "id": "whatsapp",
   "nombre": "Mensajes de WhatsApp Business API",
   "cuando": [
    "int.whatsapp_api"
   ]
  },
  {
   "id": "mapas",
   "nombre": "Uso de Google Maps",
   "cuando": [
    "int.maps",
    "tie.seguimiento",
    "res.domicilio"
   ]
  },
  {
   "id": "ia",
   "nombre": "Consumo de inteligencia artificial",
   "cuando": [
    "comparte:chatbot",
    "int.ia",
    "aut.ia"
   ]
  },
  {
   "id": "mensajes",
   "nombre": "Correo o SMS (avisos y recordatorios)",
   "cuando": [
    "comparte:recordatorios",
    "comparte:confirmaciones",
    "comparte:notificaciones"
   ]
  },
  {
   "id": "facturacion",
   "nombre": "Timbrado de facturas (PAC)",
   "cuando": [
    "int.facturacion"
   ]
  },
  {
   "id": "video",
   "nombre": "Servicio de videollamadas",
   "cuando": [
    "sal.video"
   ]
  }
 ],
 "encuesta": {
  "giros": {
   "Belleza o spa": "belleza",
   "Restaurante o cafetería": "restaurantes",
   "Tienda o comercio": "tiendas",
   "Gimnasio o deporte": "gimnasios",
   "Educación o cursos": "educacion",
   "Servicios profesionales": "empresas",
   "Salud o clínica": "salud"
  },
  "sin_tarifario": "empresas",
  "sistemas": {
   "Belleza o spa": {
    "Agendar cita con su estilista": [
     "bel.reservas",
     "bel.especialistas"
    ],
    "Galería de trabajos": [
     "bel.galeria"
    ],
    "Calificar al estilista": [
     "bel.resenas"
    ],
    "Recordatorios": [
     "bel.recordatorios"
    ],
    "Puntos y lealtad": [
     "bel.lealtad"
    ],
    "Anticipo al agendar": [
     "bel.pagos"
    ],
    "Membresías y paquetes": [
     "bel.pagos",
     "aut.renovaciones"
    ],
    "Venta de productos": [
     "bel.productos"
    ],
    "Agenda por estilista": [
     "bel.calendario",
     "bel.empleados"
    ],
    "Comisiones del personal": [
     "bel.empleados"
    ],
    "Inventario de productos": [
     {
      "id": "tie.inventario",
      "nombre": "Inventario de productos"
     }
    ],
    "Reportes": [
     "bel.admin"
    ]
   },
   "Restaurante o cafetería": {
    "Menú digital": [
     "res.menu"
    ],
    "Pedidos para llevar o domicilio": [
     "res.domicilio"
    ],
    "Reservar mesa": [
     "res.reservas"
    ],
    "Pedir desde la mesa con QR": [
     "res.qr"
    ],
    "Puntos y lealtad": [
     "res.recompensas"
    ],
    "Calificar platillo y servicio": [
     "res.resenas"
    ],
    "Pagos en la app": [
     "res.pagos"
    ],
    "Rastreo de repartidor": [
     "res.domicilio"
    ],
    "Facturación": [
     "int.facturacion"
    ],
    "Comandas a cocina": [
     "res.panel_pedidos"
    ],
    "Inventario de insumos": [
     {
      "id": "tie.inventario",
      "nombre": "Inventario de insumos"
     }
    ],
    "Turnos del personal": [
     {
      "id": "bel.empleados",
      "nombre": "Turnos y asistencia del personal"
     }
    ],
    "Reportes de ventas": [
     "res.estadisticas"
    ]
   },
   "Tienda o comercio": {
    "Catálogo de productos": [
     "tie.catalogo"
    ],
    "Compra en línea": [
     "tie.carrito",
     "tie.pagos"
    ],
    "Apartar y recoger en tienda": [
     "tie.carrito"
    ],
    "Puntos y lealtad": [
     "bel.lealtad"
    ],
    "Ofertas y novedades": [
     "tie.notificaciones",
     "tie.cupones"
    ],
    "Reseñas de productos": [
     "tie.resenas"
    ],
    "Pagos y meses sin intereses": [
     "tie.pagos"
    ],
    "Envíos y rastreo": [
     "tie.seguimiento"
    ],
    "Facturación": [
     "int.facturacion"
    ],
    "Inventario por sucursal": [
     "tie.inventario"
    ],
    "Punto de venta": [
     "int.pos"
    ],
    "Base de clientes (CRM)": [
     {
      "id": "emp.crm",
      "nombre": "Base de clientes (CRM)"
     }
    ],
    "Reportes de ventas": [
     "tie.estadisticas"
    ]
   },
   "Salud o clínica": {
    "Agendar citas": [
     "sal.agenda",
     "sal.directorio"
    ],
    "Recordatorios de cita": [
     "sal.recordatorios"
    ],
    "Teleconsulta": [
     {
      "id": "sal.video",
      "excepto": [
       "basico"
      ]
     }
    ],
    "Recetas digitales": [
     "sal.documentos"
    ],
    "Resultados de estudios": [
     "sal.documentos"
    ],
    "Calificar la atención": [
     {
      "id": "res.resenas",
      "nombre": "Calificación de la atención"
     }
    ],
    "Pagos y anticipos": [
     "sal.pagos"
    ],
    "Paquetes de tratamiento": [
     "sal.pagos"
    ],
    "Facturación": [
     "int.facturacion"
    ],
    "Expediente clínico digital": [
     "sal.historial",
     "sal.pacientes"
    ],
    "Agenda por doctor y consultorio": [
     "sal.agenda",
     "sal.especialistas"
    ],
    "Inventario de medicamentos": [
     {
      "id": "tie.inventario",
      "nombre": "Inventario de medicamentos"
     }
    ],
    "Reportes": [
     "sal.admin"
    ]
   },
   "Gimnasio o deporte": {
    "Reservar clases y horarios": [
     "gym.clases"
    ],
    "Citas con entrenador personal": [
     "gym.sesiones",
     "gym.entrenadores"
    ],
    "Seguimiento físico": [
     "gym.progreso"
    ],
    "Rutinas personalizadas": [
     "gym.planes"
    ],
    "Plan de alimentación": [
     "gym.alimentacion"
    ],
    "Calificar entrenadores": [
     "gym.resenas"
    ],
    "Retos y logros": [
     "gym.retos"
    ],
    "Check-in con QR": [
     "gym.qr",
     {
      "id": "int.acceso_qr",
      "solo": [
       "avanzado"
      ]
     }
    ],
    "Membresías con cobro automático": [
     "gym.membresias"
    ],
    "Paquetes de clases": [
     "gym.membresias"
    ],
    "Tienda en la app": [
     {
      "id": "bel.productos",
      "nombre": "Tienda en la app"
     }
    ],
    "Recordatorios y avisos": [
     "gym.notificaciones"
    ],
    "Control de acceso y asistencia": [
     "gym.qr",
     {
      "id": "int.acceso_qr",
      "solo": [
       "avanzado"
      ]
     }
    ],
    "Gestión de entrenadores": [
     "gym.entrenadores"
    ],
    "Aforo en vivo": [
     "gym.qr"
    ],
    "Reportes": [
     "gym.admin"
    ]
   },
   "Servicios profesionales": {
    "Agendar asesorías": [
     "emp.agenda"
    ],
    "Portal del cliente": [
     "emp.portal"
    ],
    "Cotizaciones en línea": [
     "emp.cotizaciones"
    ],
    "Envío de documentos": [
     "emp.documentos"
    ],
    "Firma digital": [
     "emp.firma",
     {
      "id": "esp.firma_avanzada",
      "solo": [
       "avanzado"
      ]
     }
    ],
    "Chat con tu equipo": [
     "emp.chat"
    ],
    "Pagos en línea": [
     "emp.pagos"
    ],
    "Igualas mensuales": [
     "emp.pagos",
     "aut.renovaciones"
    ],
    "Facturación": [
     "int.facturacion"
    ],
    "Prospectos y clientes (CRM)": [
     "emp.crm"
    ],
    "Tareas y proyectos": [
     "emp.proyectos"
    ],
    "Control de horas": [
     "emp.proyectos"
    ],
    "Reportes": [
     "emp.reportes"
    ]
   },
   "Educación o cursos": {
    "Cursos en línea": [
     "edu.catalogo",
     "edu.videos"
    ],
    "Inscripciones en línea": [
     "edu.estudiantes"
    ],
    "Horarios y calendario": [
     "edu.calendario"
    ],
    "Calificaciones y avance": [
     "edu.seguimiento"
    ],
    "Tareas y exámenes": [
     "edu.tareas",
     "edu.examenes"
    ],
    "Comunicación con padres": [
     "edu.comunicacion"
    ],
    "Certificados": [
     "edu.certificados"
    ],
    "Colegiaturas automáticas": [
     "edu.pagos",
     "aut.renovaciones"
    ],
    "Pagos en línea": [
     "edu.pagos"
    ],
    "Facturación": [
     "int.facturacion"
    ],
    "Asistencia": [
     "edu.asistencia"
    ],
    "Gestión de maestros": [
     "edu.profesores"
    ],
    "Reportes": [
     "edu.admin"
    ]
   },
   "Inmobiliaria o construcción": {
    "Catálogo de propiedades": [
     {
      "id": "tie.catalogo",
      "nombre": "Catálogo de propiedades"
     }
    ],
    "Recorridos virtuales": [
     {
      "id": "edu.videos",
      "nombre": "Recorridos virtuales en video"
     }
    ],
    "Agendar visitas": [
     {
      "id": "emp.agenda",
      "nombre": "Agenda de visitas"
     }
    ],
    "Simulador de crédito": [
     "esp.simulador"
    ],
    "Avance de obra": [
     {
      "id": "emp.proyectos",
      "nombre": "Avance de obra"
     }
    ],
    "Chat con asesor": [
     "emp.chat"
    ],
    "Apartado en línea": [
     "emp.pagos"
    ],
    "Estado de cuenta": [
     {
      "id": "emp.portal",
      "nombre": "Portal con estado de cuenta"
     }
    ],
    "Contratos digitales": [
     "emp.firma",
     {
      "id": "esp.firma_avanzada",
      "solo": [
       "avanzado"
      ]
     }
    ],
    "Prospectos (CRM)": [
     "emp.crm"
    ],
    "Control de obra": [
     {
      "id": "emp.proyectos",
      "nombre": "Avance de obra"
     }
    ],
    "Gestión de asesores": [
     {
      "id": "emp.empleados",
      "nombre": "Gestión de asesores"
     }
    ],
    "Reportes": [
     "emp.reportes"
    ]
   },
   "Logística o distribución": {
    "Rastreo en tiempo real": [
     {
      "id": "tie.seguimiento",
      "nombre": "Rastreo de envíos"
     }
    ],
    "Cotizar y solicitar envíos": [
     {
      "id": "emp.cotizaciones",
      "nombre": "Cotización y solicitud de envíos"
     }
    ],
    "Avisos de estatus": [
     "emp.notificaciones"
    ],
    "Prueba de entrega": [
     {
      "id": "tie.seguimiento",
      "nombre": "Rastreo de envíos"
     }
    ],
    "Pagos en línea": [
     "emp.pagos"
    ],
    "Facturación y Carta Porte": [
     {
      "id": "int.facturacion",
      "nombre": "Facturación y Carta Porte"
     }
    ],
    "App para choferes": [
     {
      "id": "res.domicilio",
      "nombre": "App para choferes y entregas"
     }
    ],
    "Optimización de rutas": [
     "esp.rutas"
    ],
    "Control de flotilla": [
     "esp.flotilla"
    ],
    "Inventario de almacén": [
     {
      "id": "tie.inventario",
      "nombre": "Inventario de almacén"
     }
    ],
    "Reportes": [
     "emp.reportes"
    ]
   },
   "_general": {
    "Pedidos en línea": [
     {
      "id": "tie.carrito",
      "nombre": "Pedidos en línea"
     }
    ],
    "Reservas y citas": [
     "emp.agenda"
    ],
    "Puntos y lealtad": [
     "bel.lealtad"
    ],
    "Catálogo / tienda": [
     {
      "id": "tie.catalogo",
      "nombre": "Catálogo de productos o servicios"
     }
    ],
    "Notificaciones": [
     "tr.push"
    ],
    "Chat con clientes": [
     "emp.chat"
    ],
    "Pagos en la app": [
     "emp.pagos"
    ],
    "Membresías": [
     "emp.pagos",
     "aut.renovaciones"
    ],
    "Entregas a domicilio": [
     {
      "id": "res.domicilio",
      "nombre": "Entregas a domicilio"
     }
    ],
    "Facturación": [
     "int.facturacion"
    ],
    "Inventario": [
     "tie.inventario"
    ],
    "Empleados y turnos": [
     "emp.empleados"
    ],
    "Base de clientes (CRM)": [
     "emp.crm"
    ],
    "Reportes y ventas": [
     "emp.reportes"
    ]
   }
  },
  "integraciones": {
   "Punto de venta o caja": "int.pos",
   "Sistema de inventario": "int.inventario",
   "Sistema de reservaciones": "int.reservas",
   "Sistema de facturación": "int.facturacion",
   "Administración de clientes (CRM)": "int.crm",
   "Otro": "esp.integracion_otra"
  },
  "diseno": {
   "Esencial": "esencial",
   "Personalizada": "personalizado",
   "Premium": "premium"
  },
  "plataforma": {
   "iPhone y Android": "ios_android",
   "Web (navegador)": "web",
   "Las dos": "web_ios_android",
   "Aún no sé": "web"
  },
  "sucursales": {
   "1 sucursal": "1",
   "2 a 5 sucursales": "2-5",
   "6 a 15 sucursales": "6-15",
   "16 a 50 sucursales": "16-50",
   "Más de 50 sucursales": "50+"
  },
  "usuarios": {
   "Menos de 100": "<100",
   "Entre 100 y 500": "100-500",
   "Entre 501 y 2,000": "501-2000",
   "Entre 2,001 y 10,000": "2001-10000",
   "Más de 10,000": "10000+",
   "No estoy seguro": "no_se"
  }
 }
}$tar$::jsonb, 'Tarifario inicial propuesto (Prompt maestro de cotizaciones v1.0)', null);
