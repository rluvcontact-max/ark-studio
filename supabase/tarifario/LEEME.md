# Tarifario y cotizaciones de ARK

Implementa el "Prompt maestro para cotizaciones inteligentes" (v1.0). El precio **lo calcula el código**, nunca Claude.

## Dónde se editan los precios

- En la app (solo el admin): **Equipo → Tarifario**, o desde el panel de cotización → **Editar tarifario**.
  - Industrias: precio base, mínimo final y módulos (precio estándar, "desde", revisión, si tiene niveles).
  - Funciones generales, integraciones, automatizaciones y "fuera del catálogo".
  - Diseño, plataformas, sucursales, usuarios, plazos (recargo %) y mantenimiento.
  - Política: oferta ×1.18, piso provisional ×0.90, meta de margen 60%, descuentos (vendedor hasta 10%, supervisor hasta 20%, más es dirección), redondeo y factores de nivel (0.7 / 1 / 1.5 / 2).
  - Avanzado (JSON): todo, incluido cómo se traduce cada respuesta de la encuesta a conceptos (`encuesta.sistemas`, `encuesta.integraciones`…).
- Cada guardado crea una **versión nueva** (tabla `tarifarios`, RPC `guardar_tarifario`). Las cotizaciones guardadas conservan la versión con la que se hicieron; el panel ofrece "Usar tarifario vigente" cuando hay una más nueva.
- `tarifario-v1.json` es la versión inicial (la que se sembró en la base). No se lee en producción: lo vigente está en la base.

## Cómo funciona

1. Llega la encuesta → `lead-encuesta` → `propuesta-claude` pide a la función `cotizacion` la **v1** (motor `cotizador.js` + `desdeEncuesta`) y manda a Claude esa cotización. Claude escribe propuesta, guion, presentación y preguntas con los montos como marcadores (`{{precio}}`, `{{mantenimiento}}`, `{{pago_1..3}}`, `{{precio_referencia}}`, `{{precio_minimo}}`).
2. En la app, paso **Cotización** de la propuesta: sumar/quitar funciones (con dependencias), niveles, diseño, plataforma, sucursales, usuarios, plazo, mantenimiento y descuento con motivo. Recalcula al instante sin guardar.
3. **Guardar versión** → la función `cotizacion` recalcula en el servidor, revisa permisos y guarda una versión inmutable (`cotizaciones`).
4. **Actualizar cotización, guion y presentación** → si el alcance es el mismo, la presentación y el guion usan la nueva versión al instante (solo cambian montos); si cambió el alcance, Claude los vuelve a escribir con esa versión.
5. **Ver cotización para el cliente** (`web/cotizacion.html`): desglose sin precio de referencia, mínimo, costos ni autorizaciones.

## Reglas principales (código: `web/cotizador.js`)

- PR (precio de referencia) = máx(mínimo de la industria, base + módulos con nivel + diseño + plataforma + sucursales + integraciones + automatizaciones + recargo de plazo). Lo incluido en otro concepto o que comparte componente (pagos, panel, notificaciones, sucursales…) se cobra una sola vez.
- Oferta = PR × 1.18. Piso provisional = PR × 0.90. Piso definitivo = máx(PR × 0.90, mínimo de la industria, costo directo / 0.40) solo cuando el admin captura el costo directo (tabla `cotizacion_costos`, solo admin).
- Descuentos sobre la oferta: hasta 10% el vendedor; más de 10% o bajar del precio de referencia sin costo validado → supervisor; más de 20% → dirección; debajo del piso → autorización extraordinaria. Hoy no hay rol de supervisor: el admin autoriza todo lo que pasa del vendedor (la versión queda "pendiente de autorización" y el admin la autoriza en el historial).
- Tamaño del negocio, presupuesto y objetivos **no** cambian el precio. Usuarios: no se cobra extra salvo "Pruebas de carga" (2,001–10,000) o revisión (más de 10,000). Plazo: no se aplica recargo automático; si el cliente lo quiere en menos de un mes, queda un aviso.
- Proyecto firmado: el vendedor no puede quitar funciones (gestión de cambios con el admin).

## Lo que queda sujeto a revisión (no se presenta como precio cerrado)

- Salud: historial clínico, documentos y resultados médicos, videoconsultas, controles avanzados de acceso (revisión técnica, de privacidad, seguridad y legal).
- Cualquier nivel **Empresarial** (×2, "desde").
- ERP, "otra" integración, firma electrónica avanzada, optimización de rutas, control de flotilla, simulador de crédito, recorridos 360°, chatbot IA avanzado.
- Más de 50 sucursales y más de 10,000 usuarios al mes.
- Funciones que pidió el cliente y no están en el catálogo (quedan como "personalizadas" en $0 hasta que el admin les ponga precio).
- Todo lo marcado "desde" (integraciones, apps nativas, diseño Premium, sucursales 16–50…) y los niveles "por definir" (respuestas "No estoy seguro" o encuestas anteriores) son precios provisionales.
- Giros sin tarifa propia (inmobiliaria, logística, otro) se cotizan como "Empresas y servicios profesionales" con aviso. Hoteles existe en el tarifario pero la encuesta no tiene ese giro: se elige en el panel.
