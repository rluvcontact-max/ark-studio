# ARK Studio

Sistema interno de ARK: panel de administración, app para empleados y encuesta para prospectos.

## Abrir el proyecto en Claude Code

1. Descomprime esta carpeta donde guardes tus proyectos.
2. Pon la encuesta en `encuesta/index.html` (ver `encuesta/LEEME.md`).
3. Abre una terminal en la carpeta y escribe `claude`. Claude Code lee `CLAUDE.md` y ya conoce todo el proyecto.

Para trabajar con la base de datos desde Claude Code, conecta Supabase y Netlify (`claude mcp add` o desde la configuración de conectores), o instala la CLI de Supabase y vincula el proyecto:

```bash
supabase link --project-ref tuaxfleudqxmvoicssqw
```

## Publicar

- **App**: carpeta `web/` → proyecto de Netlify **arkdashboardmx**.
- **Encuesta**: carpeta `encuesta/` → proyecto de Netlify **arkencuesta**.

Recomendado: subir este repo a GitHub y conectarlo a Netlify para que cada cambio se publique solo.

## Estructura

```
web/                  App (admin + empleados), PWA
encuesta/             Encuesta pública
supabase/migrations/  Esquema de la base de datos
supabase/functions/   Funciones de servidor (sync-google, lead-encuesta)
automatizaciones/     Sincronización de Grain
referencia/           Versiones anteriores
```
