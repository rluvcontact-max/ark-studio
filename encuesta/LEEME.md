# Encuesta (arkencuesta-mx.netlify.app)

`index.html` es la encuesta publicada: un solo archivo con los logos y las fotos del equipo incrustados. Para publicar, arrastra esta carpeta (o el ZIP) a Netlify → arkencuesta-mx (cuenta nueva de Netlify; con la detección de formularios activada) → Deploys.

Puntos clave del archivo:
- `EQUIPO`: clave `?v=` → nombre, foto y página de reservas de Google Calendar de cada vendedor.
- `GENERAL`: agenda que se usa cuando el link no trae `?v=`.
- Envía las respuestas a Netlify Forms (`encuesta-app`), con el campo `vendedor`.
- Después de Netlify Forms llama a la Edge Function `lead-encuesta` (función `enviarLead`), así el prospecto aparece solo en Clientes de ARK, asignado al vendedor del link.
- Pasos con flujo dinámico (`flujo()`): el paso de detalles solo aparece si elegiste sistemas con preguntas de complejidad (`MODULOS`). Contador, barra de progreso y botón atrás siguen el flujo.
- Campos nuevos: `tamano`, `sucursales`, `usuarios_mes`, `diseno`, `integraciones`, `integraciones_cual`, `objetivos`, `objetivo_otro`, `presupuesto` (opcional), `complejidad` (texto) y `cotizacion` (JSON para una futura calculadora; no se muestran precios al cliente). Si agregas un campo, decláralo también en el formulario estático oculto (Netlify lo necesita).
- No borrar giros, sistemas ni preguntas existentes.
