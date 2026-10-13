# Non-Token Combat

Hay presencias que toman parte en la batalla sin dejar huella sobre el mapa.

**Non-Token Combat** permite incorporar actores al tracker mediante fichas técnicas ligadas a ellos. Existen para que el combate pueda reconocerlos, pero el módulo silencia su imagen y todo lo que suele acompañarla: marcos, estados, barras, objetivos y marcas de turno. En el mapa no queda señal que los delate.

## Cómo invocarlos

1. Activa el módulo en **Configuración → Gestión de módulos**.
2. Abre el tracker de combate y pulsa **Añadir actores**.
3. Escoge un combate existente o crea uno nuevo.
4. Marca los actores que quieras convocar y pulsa **Añadir seleccionados**.
5. El GM puede abrir **Panel GM** desde el tracker para gestionar vida, estados y efectos de los combatientes.

Para iniciar un combate nuevo, activa primero una escena y espera a que cargue. Si eliges un combate existente, las fichas técnicas se guardarán en su escena. No tienes que colocar ni seleccionar tokens a mano.

## Detalles

- Cada actor se añade una sola vez por combate. Los usuarios no GM solo ven los actores que pueden gestionar.
- Las fichas técnicas se eliminan al retirar al combatiente o borrar el combate.
- En sus filas no aparecen los controles de resaltar o enfocar una ficha invisible.
- Pulsar sus retratos en el tracker o en carruseles compatibles no mueve la vista del mapa.
- Su posición sirve de anclaje técnico, no expresa una ubicación táctica. No cuentes con ella para medir alcance, línea de visión ni otras reglas espaciales.
- El estado **Derrotado** se gestiona desde el combatiente del tracker.
- El panel del GM muestra los estados configurados como botones de icono por combatiente; al pulsarlos se activan o desactivan mediante la API nativa de estados de Foundry.
- En Fabula Ultima, Crisis y KO se muestran pero no se pueden alternar manualmente: el sistema los calcula a partir de los PG.
- También permite seleccionar varios combatientes para sumar o restar vida.
- La edición directa reconoce rutas habituales y recursos de vida anidados (`HP`, `Health`, `Vida`, `PV`, `PG`), incluyendo la ruta de Fabula Ultima `system.resources.hp.value/max`. Como los sistemas pueden definir sus propios esquemas, una ruta con nombres no convencionales podría requerir una integración adicional.

## Compatibilidad

- Foundry Virtual Tabletop 14 o posterior.
- API ApplicationV2.
- Sin dependencias externas.
