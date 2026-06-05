---
name: run-local
description: Levanta el servidor IBT GTM localmente en Windows/PowerShell y prueba los endpoints (/health, /generar, /resultado, /generar-reporte). Verifica dependencias y env vars antes de arrancar. Úsalo cuando quieras correr el servicio en local para probar un cambio. Se invoca con /run-local.
---

# run-local — levantar y probar el servicio en local (Windows)

## Paso 1 — Prerrequisitos

```powershell
node --version          # requiere >=18
Test-Path .\node_modules    # si es False, correr: npm install
```

Env vars obligatorias (`ANTHROPIC_API_KEY`, `IBT_EMAIL`, `IBT_PASSWORD`). Comprobá si están seteadas:

```powershell
'ANTHROPIC_API_KEY','IBT_EMAIL','IBT_PASSWORD' | ForEach-Object {
  "{0} = {1}" -f $_, $(if ([Environment]::GetEnvironmentVariable($_)) {'SET'} else {'FALTA'})
}
```

Si falta alguna, seteala en la sesión actual (no la imprimas en logs):

```powershell
$env:ANTHROPIC_API_KEY = 'sk-ant-...'
$env:IBT_EMAIL = '...'
$env:IBT_PASSWORD = '...'
```

> Nota Puppeteer: en local descarga su propio Chromium al `npm install`. En Railway lo provee `nixpacks.toml`. Si en Windows falla el lanzado del browser, es un tema de Puppeteer/Chromium local, no del pipeline.

## Paso 2 — Arrancar el server (en background)

Lanzalo en background para no bloquear la terminal, y esperá el log de arranque:

```powershell
npm start
```

Arranca en `http://localhost:3000` (o `$env:PORT`). El log de arranque dice `Servidor corriendo en puerto 3000 (NUM_CUENTAS=3, EXPECTED_PAGES=no validar)`.

## Paso 3 — Probar

**Health:**
```powershell
Invoke-RestMethod http://localhost:3000/health
```

**Reporte síncrono (lo más útil para probar end-to-end)** — tarda (research + sourcing + juez). Subí el timeout:
```powershell
$body = @{ email='contacto@empresa.com'; dominio='empresa.com'; eval=$true } | ConvertTo-Json
Invoke-RestMethod http://localhost:3000/generar-reporte -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 600 | ConvertTo-Json -Depth 10
```

**Flujo async (como lo usa N8N):**
```powershell
$body = @{ email='c@empresa.com'; dominio='empresa.com'; empresa='Empresa'; nombre='Juan'; profileId='' } | ConvertTo-Json
$r = Invoke-RestMethod http://localhost:3000/generar -Method Post -Body $body -ContentType 'application/json'
$r.jobId
# Polling:
Invoke-RestMethod "http://localhost:3000/resultado/$($r.jobId)"
```

**Guardar el PDF a disco** (el campo es base64):
```powershell
$res = Invoke-RestMethod "http://localhost:3000/resultado/$($r.jobId)"
[IO.File]::WriteAllBytes("$PWD\salida.pdf", [Convert]::FromBase64String($res.pdf_base64))
```

## Paso 4 — Diagnóstico rápido por logs

Los logs salen con prefijo de etapa: `[CLIENTE]` (resolución), `[SOURCE]` (sourcing — mirá "pool", "cuentas-ancla", "a la IA"), `[SELECT]` (descartes por función/mezcla/empresa), `[JUDGE]` (veredicto), `[GEO]`/`[TAM]` (guardas), `[TOKENS]` (costo). Si `[SOURCE]` dice 0 candidatos → tema de términos/industria/geografía (ver agente `mcp-salesnav-debug`).

Para ver cada query de web_search del PLAN: arrancá con `$env:WS_DEBUG = '1'`.
