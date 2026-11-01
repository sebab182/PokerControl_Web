# Migrar datos desde la APK

1. En la APK, abrí "Acerca de" (tocando el título) y exportá el JSON.
2. En la web, entrá al grupo de destino: **Configuración → Backup → Importar JSON**.
3. Revisá los conteos y avisos de la vista previa.
4. Confirmá con **Reemplazar todo**. Reemplaza todos los datos de ese grupo y no se puede deshacer.

Conviene importar en un grupo nuevo y comparar ranking y deudas antes de seguir usándolo.

## Cómo se traducen los datos

| Caso | Resultado |
|---|---|
| Ids | Se generan nuevos: el mismo backup se puede importar en varios grupos |
| Jugador borrado en la app | Se reconstruye archivado, con el nombre guardado en partidas y deudas |
| Partida sin temporada válida | Va a "Temporada 1", que se crea si hace falta |
| Partida o temporada cerrada sin `closedAt` | Usa `createdAt` |
| Deuda `ajuste_previo` | Manual |
| Deuda `neteado` | Consolidada |
| Deuda de una partida inexistente | Consolidada, con aviso |
| Consolidada con ajuste previo | Entra entera como manual, porque el backup no distingue las partes; con aviso |
| Montos con más de 2 decimales | Se redondean, con aviso |
| `status` | Se recalcula |
| Participantes duplicados | Se fusionan, con aviso |
| Compras o deudas inválidas | Se omiten, con aviso |
| Más de una temporada activa | Se rechaza el archivo (422) |
