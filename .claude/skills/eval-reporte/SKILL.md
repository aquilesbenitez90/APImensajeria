---
name: eval-reporte
description: Dispara el pipeline GTM contra un lead de prueba (empresa/dominio/email) en modo eval y audita el objeto `data` resultante buscando datos inventados, incoherencia geográfica, tamaño fuera de ICP y cards incompletas. Úsalo para medir la calidad real del producto antes de mandar un reporte, o para validar que un cambio en los prompts/sourcing no rompió nada. Se invoca con /eval-reporte.
---

# eval-reporte — auditoría de calidad del reporte GTM

Objetivo: ejecutar el pipeline real contra un lead y **auditar el resultado con el mismo rigor que el juez + las guardas determinísticas**, reportando hallazgos accionables. El producto vive o muere por la credibilidad, así que sé paranoico: en duda, marcá el hallazgo.

## Paso 0 — Insumos

El usuario debería pasar al menos `dominio` (obligatorio en `/generar-reporte`) y `email`. Si solo dio una empresa, pedí el dominio o un email de contacto. Aceptá también `profileId`, `nombre`, `empresa`.

Confirmá que existen las env vars `ANTHROPIC_API_KEY`, `IBT_EMAIL`, `IBT_PASSWORD` (sin ellas el pipeline falla). Si el server no está corriendo localmente, usá la skill `/run-local` o apuntá a la URL de Railway que indique el usuario.

## Paso 1 — Disparar en modo eval

Llamá al endpoint **síncrono** con `eval:true` para recuperar el objeto `data` estructurado (no solo el PDF base64):

```powershell
$body = @{ email='contacto@empresa.com'; dominio='empresa.com'; eval=$true } | ConvertTo-Json
Invoke-RestMethod -Uri 'http://localhost:3000/generar-reporte' -Method Post -Body $body -ContentType 'application/json' | ConvertTo-Json -Depth 10
```

La respuesta incluye: `reporte` (el objeto `data`), `juez` ("APROBADO|RECHAZADO N/8"), `juez_fixes`, `apto_envio`, `cards_validas`, `paginas`, `cliente_resuelto`, `tokens`. Guardá el JSON para auditarlo.

## Paso 2 — Auditoría (replicá los 8 criterios del juez + las guardas)

Revisá el objeto `reporte` contra esta checklist. Para cada ítem, PASS/FAIL con cita textual del campo problemático.

**Datos inventados (lo más grave)** — auditá SOLO lo que escribe la IA: `lead`, `proof`, `context[]`, `apertura[]`, `stats[]`, `ribbon[]`, y `angulo`/`hook` de cada card. NO marques como inventados los datos duros de las cards (nombre, cargo, empresa, ubicación, grado, urn) — esos vienen de Sales Navigator real.
- ¿Hay métricas duras sin fuente? (años de fundación, "+300 categorías", "+470.000 servicios", "60 minutos", %, premios). Las regex `_sinInventos` deberían haber suavizado los conteos típicos; si quedó alguno, es FAIL.
- ¿Atribuye certificaciones/pólizas/ISO/"24-7"/"garantía X horas" sin fuente? FAIL.
- ¿Nombra una empresa específica como cliente/aliado del cliente? FAIL salvo fuente explícita.

**Personalización del ángulo y hook (lo escribe la IA)** — por cada card:
- ¿`angulo` y `hook` son únicos y específicos de ESA persona/empresa? ¿O repiten estructura/fórmula entre cards? Genérico ("escalar tu operación") → FAIL.
- ¿El `hook` empieza por el primer nombre de la persona de ESA card? ¿El ángulo nombra a la persona/empresa correcta (no mezcla con otra card)? La guarda `armarReporte` ya descarta mezclas, pero verificá.
- ¿El ángulo infla o cambia el cargo respecto del campo `cargo`? FAIL.

**Coherencia geográfica** (replica `_geoIncoherente`): los países en `cards[].ubicacion` deben intersecar con los países del `h1_post` y del icp "Geografía". Card en otro país → FAIL.

**Coherencia de tamaño** (replica `_tamanoIncoherente`): si el ICP define `tamano_min`, ninguna card debería estar claramente por debajo (margen 0.5).

**Integridad / estructura**:
- Cantidades exactas: ribbon 3, stats 4, icp 4, context 3, apertura 3, prioridades 4, cards = NUM_CUENTAS. Faltantes → FAIL.
- Sin `{{...}}` crudos, `undefined`, `[INSERT]`, `TODO`, lorem ipsum, ni cards vacías.
- Links `/in/` (slug limpio o urn opaco `ACwAA...`); NUNCA `/company/`.
- Sin guiones (— ni -) como conectores en los textos generados.
- Español neutro, trato de usted, sin voseo.

**Empresas distintas**: cada card de una empresa diferente.

## Paso 3 — Veredicto

Reportá al usuario:
1. **Veredicto del propio sistema**: `juez`, `apto_envio`, `cards_validas`, `paginas`, y los `juez_fixes` si los hubo.
2. **Tu auditoría independiente**: tabla de hallazgos (criterio | PASS/FAIL | cita | fix sugerido). No te limites a confiar en el juez: el juez tiene puntos ciegos (por eso existen las guardas determinísticas).
3. **Costo**: tokens y ~$ del run.
4. **Recomendación**: ¿apto para enviar? Si no, qué prompt o parámetro tocar (derivá al agente `gtm-prompt-editor` si es un tema de prompts, o `mcp-salesnav-debug` si el sourcing trajo candidatos malos/insuficientes).

## Notas

- Si querés auditar varios leads, corré el endpoint para cada uno y resumí en una tabla comparativa.
- Para depurar el research del PLAN, seteá `WS_DEBUG=1` antes de levantar el server: loguea cada query de web_search.
- Modo barato: si solo querés ver el JSON sin renderizar PDF repetido, igual usá `/generar-reporte` con `eval:true` (es un único pipeline completo).
