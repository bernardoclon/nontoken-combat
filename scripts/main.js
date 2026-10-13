import {
  closeCombatDashboardsForCombat,
  openCombatDashboard,
  refreshCombatDashboards,
  refreshCombatDashboardsForCombat
} from "./combat-dashboard.mjs";

const MODULE_ID = "nontoken-combat";
const TEMPLATE = `modules/${MODULE_ID}/templates/actor-picker.hbs`;
const virtualTokenDeletions = new Set();
const virtualControlObservers = new WeakMap();

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class NonTokenCombatPicker extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-picker`,
    classes: [MODULE_ID],
    window: {
      title: "Añadir actores al combate",
      icon: "fa-solid fa-user-plus",
      resizable: true
    },
    position: {
      width: 520,
      height: "auto"
    },
    actions: {
      addSelected: this.#onAddSelected,
      toggleAll: this.#onToggleAll
    }
  };

  static PARTS = {
    main: {
      template: TEMPLATE
    }
  };

  async _prepareContext() {
    const activeCombatId = game.combat?.id;
    const combats = game.combats.contents
      .filter((combat) => !combat.isArchived)
      .map((combat) => ({
        id: combat.id,
        label: `${combat.name || "Combate"}${combat.id === activeCombatId ? " (activo)" : ""}`,
        selected: combat.id === activeCombatId
      }));

    const actors = game.actors.contents
      .filter((actor) => game.user.isGM || actor.isOwner)
      .sort((a, b) => Number(b.hasPlayerOwner) - Number(a.hasPlayerOwner)
        || a.name.localeCompare(b.name, game.i18n.lang))
      .map((actor) => ({
        id: actor.id,
        name: actor.name,
        searchName: actor.name.toLocaleLowerCase(game.i18n.lang),
        img: actor.img,
        type: actor.type
      }));

    return {
      combats,
      actors,
      createNewCombat: !activeCombatId
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const search = this.element.querySelector("[name='actorSearch']");
    search?.addEventListener("input", () => {
      const query = search.value.trim().toLocaleLowerCase(game.i18n.lang);
      for (const row of this.element.querySelectorAll(".nontoken-combat-actor")) {
        row.hidden = !row.dataset.actorName.includes(query);
      }
    });
  }

  static #onToggleAll() {
    const checkboxes = this.element.querySelectorAll(
      ".nontoken-combat-actor:not([hidden]) input[type='checkbox']"
    );
    const shouldCheck = [...checkboxes].some((checkbox) => !checkbox.checked);
    for (const checkbox of checkboxes) checkbox.checked = shouldCheck;
  }

  static async #onAddSelected() {
    const actorIds = [...this.element.querySelectorAll("input[name='actorIds']:checked")]
      .map((checkbox) => checkbox.value);
    if (!actorIds.length) {
      ui.notifications.warn("Selecciona al menos un actor.");
      return;
    }

    const activeScene = globalThis.canvas?.ready ? globalThis.canvas.scene : null;
    const combatId = this.element.querySelector("[name='combatId']")?.value;
    let combat = combatId === "new" ? null : game.combats.get(combatId);

    if (!combat) {
      if (!activeScene) {
        ui.notifications.warn("Activa una escena y espera a que termine de cargar antes de crear un combate.");
        return;
      }
      try {
        combat = await Combat.create({ scene: activeScene.id, active: true });
      } catch (error) {
        console.error(`${MODULE_ID} | No se pudo crear el combate.`, error);
        ui.notifications.error("No se pudo crear el combate.");
        return;
      }
    }

    if (!combat) {
      ui.notifications.error("No se pudo crear o encontrar el combate.");
      return;
    }

    const existingActorIds = new Set(
      combat.combatants.contents.map((combatant) => combatant.actorId).filter(Boolean)
    );
    const newActorIds = [...new Set(actorIds)].filter((id) => !existingActorIds.has(id));
    if (!newActorIds.length) {
      ui.notifications.info("Los actores seleccionados ya están en este combate.");
      return;
    }

    const sceneId = combat.sceneId ?? activeScene?.id;
    const scene = sceneId ? game.scenes.get(sceneId) : null;
    if (!scene) {
      ui.notifications.error("El combate no tiene una escena disponible para crear sus fichas técnicas.");
      return;
    }

    const actors = newActorIds.map((actorId) => game.actors.get(actorId));
    if (actors.some((actor) => !actor)) {
      ui.notifications.error("No se encontraron todos los actores seleccionados.");
      return;
    }

    const createdTokens = [];
    try {
      const occupiedTokens = [...scene.tokens.contents];
      for (const actor of actors) {
        const tokenData = createVirtualTokenData(actor, scene, occupiedTokens);
        const [token] = await scene.createEmbeddedDocuments("Token", [tokenData]);
        if (!token) throw new Error(`Foundry no creó la ficha técnica de ${actor.name}.`);
        createdTokens.push(token);
        occupiedTokens.push(token);
      }

      const combatants = createdTokens.map((token, index) => ({
        actorId: actors[index].id,
        sceneId,
        tokenId: token.id,
        hidden: false
      }));
      await combat.createEmbeddedDocuments("Combatant", combatants);
    } catch (error) {
      const linkedTokenIds = new Set(
        combat.combatants.contents.map((combatant) => combatant.tokenId).filter(Boolean)
      );
      const orphanTokenIds = createdTokens
        .filter((token) => !linkedTokenIds.has(token.id))
        .map((token) => token.id);
      if (orphanTokenIds.length) {
        try {
          await scene.deleteEmbeddedDocuments("Token", orphanTokenIds);
        } catch (cleanupError) {
          console.error(`${MODULE_ID} | No se pudieron limpiar fichas técnicas incompletas.`, cleanupError);
        }
      }
      console.error(`${MODULE_ID} | No se pudieron añadir los actores al combate.`, error);
      ui.notifications.error("No se pudieron crear las fichas técnicas o los combatientes. Revisa la consola.");
      return;
    }

    ui.notifications.info(`Se añadieron ${actors.length} actor(es) al combate con fichas técnicas invisibles.`);
    this.close();
  }
}

function createVirtualTokenData(actor, scene, occupiedTokens) {
  const tokenData = actor.prototypeToken?.toObject();
  if (!tokenData) throw new Error(`El actor ${actor.name} no tiene una ficha prototipo válida.`);

  const gridSize = Number(scene.grid?.size) || 100;
  const sceneWidth = Number(scene.width || scene.dimensions?.sceneWidth) || gridSize * 10;
  const sceneHeight = Number(scene.height || scene.dimensions?.sceneHeight) || gridSize * 10;
  const tokenWidth = Math.max(1, Number(tokenData.width) || 1) * gridSize;
  const tokenHeight = Math.max(1, Number(tokenData.height) || 1) * gridSize;
  const maxColumn = Math.max(0, Math.floor((sceneWidth - tokenWidth) / gridSize));
  const maxRow = Math.max(0, Math.floor((sceneHeight - tokenHeight) / gridSize));
  let position;

  for (let row = maxRow; row >= 0 && !position; row--) {
    for (let column = maxColumn; column >= 0; column--) {
      const candidate = { x: column * gridSize, y: row * gridSize };
      const overlaps = occupiedTokens.some((token) => tokenOverlaps(token, candidate, tokenWidth, tokenHeight, gridSize));
      if (!overlaps) {
        position = candidate;
        break;
      }
    }
  }

  // Si la escena no tiene celdas libres, la ficha sigue siendo invisible; su posición no es táctica.
  position ??= {
    x: Math.max(0, sceneWidth - tokenWidth),
    y: Math.max(0, sceneHeight - tokenHeight)
  };

  delete tokenData._id;
  tokenData.name = actor.name;
  tokenData.actorId = actor.id;
  tokenData.actorLink = true;
  tokenData.x = position.x;
  tokenData.y = position.y;
  tokenData.hidden = true;
  tokenData.alpha = 0;
  tokenData.displayName = CONST.TOKEN_DISPLAY_MODES.NONE;
  tokenData.displayBars = CONST.TOKEN_DISPLAY_MODES.NONE;
  tokenData.sight = { ...tokenData.sight, enabled: false, range: 0 };
  tokenData.light = { ...tokenData.light, bright: 0, dim: 0 };
  tokenData.detectionModes = [];
  tokenData.flags = foundry.utils.mergeObject(tokenData.flags ?? {}, {
    [MODULE_ID]: { virtualToken: true }
  }, { inplace: false });
  return tokenData;
}

function tokenOverlaps(token, position, width, height, gridSize) {
  const tokenX = Number(token.x) || 0;
  const tokenY = Number(token.y) || 0;
  const tokenWidth = Math.max(1, Number(token.width) || 1) * gridSize;
  const tokenHeight = Math.max(1, Number(token.height) || 1) * gridSize;
  return position.x < tokenX + tokenWidth
    && position.x + width > tokenX
    && position.y < tokenY + tokenHeight
    && position.y + height > tokenY;
}

function hideCanvasPart(part) {
  if (!part) return;
  part.visible = false;
  part.renderable = false;
  part.interactive = false;
  part.interactiveChildren = false;
  if ("eventMode" in part) part.eventMode = "none";
}

function concealVirtualToken(placeable) {
  const token = placeable?.document ? placeable : placeable?.object;
  if (!token?.document?.getFlag(MODULE_ID, "virtualToken")) return;

  // The border, target markers, and turn marker can render outside the token's main mesh.
  for (const part of [
    token,
    token.border,
    token.mesh,
    token.voidMesh,
    token.nameplate,
    token.bars,
    token.effects,
    token.controlIcon,
    token.levelIndicator,
    token.targetArrows,
    token.targetPips,
    token.turnMarker,
    token.tooltip,
    token.ring,
    token.ruler
  ]) hideCanvasPart(part);
}

function concealAllVirtualTokens() {
  if (!globalThis.canvas?.ready) return;
  for (const token of canvas.tokens.placeables) concealVirtualToken(token);
}

function addTrackerButton(app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0] ?? app.element;
  if (!root?.querySelector) return;
  installVaesenDefeatedToggle(app, root);
  hideVirtualTokenMapControls(app, root);
  const controls = [];

  if (!root.querySelector(`[data-${MODULE_ID}-button]`)) {
    const button = document.createElement("button");
    button.type = "button";
    button.classList.add("header-control", `${MODULE_ID}-control`);
    button.dataset.nontokenCombatButton = "";
    button.setAttribute("aria-label", "Añadir actores al combate");
    button.setAttribute("data-tooltip", "Añadir actores al combate con fichas invisibles");
    button.innerHTML = '<i class="fa-solid fa-user-plus" aria-hidden="true"></i><span>Añadir actores</span>';
    button.addEventListener("click", () => new NonTokenCombatPicker().render(true));
    controls.push(button);
  }

  if (game.user.isGM && !root.querySelector(`[data-${MODULE_ID}-dashboard]`)) {
    const dashboardButton = document.createElement("button");
    dashboardButton.type = "button";
    dashboardButton.classList.add("header-control", `${MODULE_ID}-control`);
    dashboardButton.dataset.nontokenCombatDashboard = "";
    dashboardButton.setAttribute("aria-label", "Abrir panel de combate del GM");
    dashboardButton.setAttribute("data-tooltip", "Administrar vida y efectos de los combatientes");
    dashboardButton.innerHTML = '<i class="fa-solid fa-heart-pulse" aria-hidden="true"></i><span>Panel GM</span>';
    dashboardButton.addEventListener("click", () => openCombatDashboard(app.viewed ?? game.combat));
    controls.push(dashboardButton);
  }

  if (!controls.length) return;

  const header = root.querySelector(
    ".combat-tracker-header, .directory-header, .window-header-actions, .header-actions"
  );
  if (header?.matches(".window-header-actions, .header-actions")) {
    header.prepend(...controls);
    return;
  }

  const toolbar = document.createElement("div");
  toolbar.classList.add(`${MODULE_ID}-toolbar`);
  toolbar.append(...controls);
  if (header) {
    header.insertAdjacentElement("afterend", toolbar);
    return;
  }

  const tracker = root.querySelector("#combat-tracker, .combat-tracker");
  if (tracker) tracker.before(toolbar);
  else root.prepend(toolbar);
}

function isVirtualTokenCombatant(combatant) {
  if (!combatant?.sceneId || !combatant.tokenId) return false;
  const scene = game.scenes.get(combatant.sceneId);
  return scene?.tokens.get(combatant.tokenId)?.getFlag(MODULE_ID, "virtualToken") ?? false;
}

function blockVirtualPortraitNavigation(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target.closest(`.${MODULE_ID}-dashboard`)) return;
  const row = target.closest("[data-combatant-id], [data-token-id]");
  if (!row) return;

  const combatantId = row.dataset.combatantId;
  const tokenId = row.dataset.tokenId;
  const combatant = game.combats.contents
    .flatMap((combat) => combat.combatants.contents)
    .find((entry) => entry.id === combatantId || (tokenId && entry.tokenId === tokenId));
  if (!isVirtualTokenCombatant(combatant)) return;

  const rollInitiativeControl = target.closest(
    '.roll-initiative, [data-action="rollInitiative"], [data-action="rollInitiative" i]'
  );
  const dockAction = target.closest(
    '.combatant-portrait .action, .combatant-portrait .system-icon, .combatant-portrait [data-action="player-pass"]'
  );

  const initiativeNumber = target.closest(
    '[class~="initiative" i], .token-initiative, [class*="initiative-value" i], [class*="initiative-number" i], [class*="combatant-initiative" i], .portrait-initiative'
  );
  if (combatant.initiative == null && (rollInitiativeControl || initiativeNumber)) return;
  if (combatant.initiative != null && (rollInitiativeControl || initiativeNumber)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }

  const mapControl = target.closest("button, a, [role='button'], [data-action]");
  if (mapControl && isVirtualTokenMapControl(mapControl, row)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if (dockAction && !rollInitiativeControl) return;

  const portraitOrName = target.closest(
    '.combatant-portrait, .token-image, [class*="portrait"], [class*="avatar"], [class*="token-image"], .token-name, .combatant-name'
  );
  const interactiveControl = target.closest(
    "button, input, select, textarea, a, [role='button'], [data-action], .action, .system-icon"
  );
  if (interactiveControl) {
    if (portraitOrName && !dockAction) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();
}

function installVirtualPortraitClickBlocker() {
  document.addEventListener("click", blockVirtualPortraitNavigation, true);
}

function hideVirtualTokenMapControls(app, root) {
  const hideControls = () => {
    const combat = app.viewed ?? game.combat;
    if (!combat) return;

    for (const row of root.querySelectorAll("[data-combatant-id], [data-token-id]")) {
      const tokenId = row.dataset.tokenId;
      const combatant = combat.combatants.get(row.dataset.combatantId)
        ?? (tokenId ? combat.combatants.contents.find((entry) => entry.tokenId === tokenId) : null);
      if (!isVirtualTokenCombatant(combatant)) continue;

      for (const control of row.querySelectorAll("button, a, [role='button'], [data-action]")) {
        if (!isVirtualTokenMapControl(control, row)) continue;
        if (!control.hidden) control.hidden = true;
        if (control.getAttribute("aria-hidden") !== "true") {
          control.setAttribute("aria-hidden", "true");
        }
      }
    }
  };

  hideControls();

  virtualControlObservers.get(app)?.disconnect();
  const observer = new MutationObserver(hideControls);
  observer.observe(root, { childList: true, subtree: true });
  virtualControlObservers.set(app, observer);
}

function isVirtualTokenMapControl(control, row) {
  const action = control.dataset.action ?? "";
  const details = [
    action,
    control.dataset.tooltip,
    control.getAttribute("aria-label"),
    control.getAttribute("title"),
    typeof control.className === "string" ? control.className : "",
    typeof row?.className === "string" ? row.className : ""
  ].filter(Boolean).join(" ").toLocaleLowerCase();
  const directMapAction = /pan.?to|focus.?((token)|(combatant))|locat|localiz|ping|center|centre|centr|navigat|enfoc|map.?token|token.?map/i;
  const navigation = /pan|focus|locat|localiz|ping|center|centre|centr|navigat|enfoc|map/i;
  const subject = /token|combatant|actor|map|ficha|personaje/i;
  return directMapAction.test(action) || (navigation.test(details) && subject.test(details));
}

function installVaesenDefeatedToggle(app, root) {
  if (root.dataset.nontokenVaesenDefeatedHandler === "true") return;
  root.dataset.nontokenVaesenDefeatedHandler = "true";

  root.addEventListener("click", async (event) => {
    if (game.system.id !== "vaesen" || !game.modules.get("yze-combat")?.active) return;

    const eventTarget = event.target instanceof Element ? event.target : null;
    const button = eventTarget?.closest('button[data-action="toggleDefeated"]');
    if (!button || !root.contains(button)) return;

    const row = button.closest("[data-combatant-id]");
    const combat = app.viewed ?? game.combat;
    const combatant = row?.dataset.combatantId
      ? combat?.combatants.get(row.dataset.combatantId)
      : null;
    const scene = combatant?.sceneId ? game.scenes.get(combatant.sceneId) : null;
    const token = combatant?.tokenId ? scene?.tokens.get(combatant.tokenId) : null;
    if (!combatant || !token?.getFlag(MODULE_ID, "virtualToken")) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      await combat.updateEmbeddedDocuments("Combatant", [
        { _id: combatant.id, defeated: !combatant.defeated }
      ]);
    } catch (error) {
      console.error(`${MODULE_ID} | No se pudo cambiar el estado de derrota del combatiente.`, error);
      ui.notifications.error("No se pudo cambiar el estado de derrota del combatiente.");
    }
  }, true);
}

async function deleteVirtualToken(combatant) {
  if (!combatant.tokenId || !combatant.sceneId) return;
  const deletionKey = `${combatant.sceneId}:${combatant.tokenId}`;
  if (virtualTokenDeletions.has(deletionKey)) return;

  const scene = game.scenes.get(combatant.sceneId);
  const token = scene?.tokens.get(combatant.tokenId);
  if (!token?.getFlag(MODULE_ID, "virtualToken")) return;

  virtualTokenDeletions.add(deletionKey);
  try {
    await scene.deleteEmbeddedDocuments("Token", [token.id]);
  } catch (error) {
    console.error(`${MODULE_ID} | No se pudo eliminar una ficha técnica.`, error);
  } finally {
    virtualTokenDeletions.delete(deletionKey);
  }
}

async function cleanupOrphanVirtualTokens() {
  if (!game.user.isGM) return;

  const linkedTokens = new Set();
  for (const combat of game.combats.contents) {
    for (const combatant of combat.combatants.contents) {
      if (combatant.sceneId && combatant.tokenId) {
        linkedTokens.add(`${combatant.sceneId}:${combatant.tokenId}`);
      }
    }
  }

  for (const scene of game.scenes.contents) {
    const orphanIds = scene.tokens.contents
      .filter((token) => token.getFlag(MODULE_ID, "virtualToken"))
      .filter((token) => !linkedTokens.has(`${scene.id}:${token.id}`))
      .map((token) => token.id);
    if (!orphanIds.length) continue;

    try {
      await scene.deleteEmbeddedDocuments("Token", orphanIds);
    } catch (error) {
      console.warn(`${MODULE_ID} | No se pudieron limpiar fichas técnicas huérfanas de ${scene.name}.`, error);
    }
  }
}

Hooks.on("renderCombatTracker", addTrackerButton);
Hooks.on("drawToken", concealVirtualToken);
Hooks.on("refreshToken", concealVirtualToken);
Hooks.on("controlToken", concealVirtualToken);
Hooks.on("hoverToken", concealVirtualToken);
Hooks.on("targetToken", (_user, token) => concealVirtualToken(token));
Hooks.on("canvasReady", concealAllVirtualTokens);
Hooks.on("combatTurn", concealAllVirtualTokens);
Hooks.on("combatTurnChange", concealAllVirtualTokens);
Hooks.on("deleteCombatant", deleteVirtualToken);
Hooks.on("updateActor", (actor) => refreshCombatDashboards(actor));
Hooks.on("createCombatant", (combatant) => refreshCombatDashboardsForCombat(combatant.parent));
Hooks.on("combatEnd", (combat) => closeCombatDashboardsForCombat(combat));
Hooks.on("deleteCombatant", (combatant) => {
  const combat = combatant.parent;
  if (combat?.combatants.contents.length === 0) closeCombatDashboardsForCombat(combat);
});
Hooks.on("updateCombat", (combat, changes) => {
  if ((Object.hasOwn(changes, "round") && Number(changes.round) === 0)
    || changes.started === false) {
    closeCombatDashboardsForCombat(combat);
  }
});
for (const hook of ["createItem", "updateItem", "deleteItem", "createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
  Hooks.on(hook, (document) => {
    const actor = document.documentName === "Actor" ? document : document.parent;
    if (actor?.documentName === "Actor") refreshCombatDashboards(actor);
  });
}
Hooks.on("deleteCombat", async (combat) => {
  await closeCombatDashboardsForCombat(combat);
  await Promise.all(combat.combatants.contents.map(deleteVirtualToken));
});

Hooks.once("ready", async () => {
  installVirtualPortraitClickBlocker();
  game.modules.get(MODULE_ID).api = {
    open: () => new NonTokenCombatPicker().render(true),
    openDashboard: (combat = game.combat) => openCombatDashboard(combat)
  };
  await cleanupOrphanVirtualTokens();
  concealAllVirtualTokens();
  console.info(`${MODULE_ID} | listo`);
});
