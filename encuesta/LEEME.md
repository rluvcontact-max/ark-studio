# Encuesta (arkencuesta.netlify.app)

Aquí va `index.html` de la encuesta publicada. Es un solo archivo de unos 110 KB, con los logos y las fotos del equipo incrustados.

Cómo conseguirlo: descárgalo de https://arkencuesta.netlify.app (Claude te lo puede bajar) y guárdalo aquí como `encuesta/index.html`.

Puntos clave del archivo:
- `EQUIPO`: clave `?v=` → nombre, foto y página de reservas de Google Calendar de cada vendedor.
- `GENERAL`: agenda que se usa cuando el link no trae `?v=`.
- Envía las respuestas a Netlify Forms (`encuesta-app`), con el campo `vendedor`.
- Pendiente: llamar también a la Edge Function `lead-encuesta` para que el prospecto aparezca solo en Clientes de ARK.
