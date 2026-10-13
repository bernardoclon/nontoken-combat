const MODULE_ID = "nontoken-combat";
const TEMPLATE = `modules/${MODULE_ID}/templates/combat-dashboard.hbs`;
const statusTogglesInFlight = new Set();
const combatDashboards = new Set();
const HEALTH_RESOURCE_NAMES = new Set([
  "hp", "health", "hitpoint", "hitpoints", "life", "lives", "vida", "vidas",
  "pv", "pg", "vitality", "vitalitypoints", "puntosdevida", "puntodevida"
]);
const HEALTH_CURRENT_NAMES = new Set(["value", "current", "currentvalue", "now", "amount"]);
const HEALTH_MAX_NAMES = new Set(["max", "maximum", "maxvalue", "maxamount", "total"]);

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class NonTokenCombatDashboard extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-dashboard`,
    classes: [MODULE_ID, `${MODULE_ID}-dashboard-window`],
    window: {
      title: "Panel de combate del GM",
      icon: "fa-solid fa-heart-pulse",
      resizable: true
    },
    position: {
      width: 520,
      height: 460
    },
    actions: {
      toggleAll: this.#onToggleAll,
      applyBulkHealth: this.#onApplyBulkHealth,
      setHealth: this.#onSetHealth,
      toggleStatusMenu: this.#onToggleStatusMenu,
      toggleStatus: this.#onToggleStatus,
      toggleDefeated: this.#onToggleDefeated
    }
  };

  static PARTS = {
    main: {
      template: TEMPLATE
    }
  };

  constructor(combatId = game.combat?.id, options = {}) {
    const combat = typeof combatId === "string" ? game.combats.get(combatId) : combatId;
    const combatantCount = combat?.combatants.contents.length ?? 0;
    const dynamicHeight = Math.max(180, 150 + Math.min(combatantCount, 5) * 58);
    super({
      ...options,
      position: {
        ...options.position,
        height: options.position?.height ?? dynamicHeight
      }
    });
    this.combatId = typeof combatId === "string" ? combatId : combatId?.id;
    this.selectedCombatantIds = new Set();
    combatDashboards.add(this);
  }

  get combat() {
    return game.combats.get(this.combatId) ?? game.combat;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const checkboxes = [...this.element.querySelectorAll("input[name='combatantIds']")];
    for (const checkbox of checkboxes) {
      checkbox.addEventListener("change", () => {
        this.selectedCombatantIds = new Set(
          checkboxes.filter((item) => item.checked).map((item) => item.value)
        );
        const allSelected = checkboxes.length > 0 && checkboxes.every((item) => item.checked);
        this.element.querySelector("[data-action='toggleAll']")
          ?.setAttribute("aria-pressed", String(allSelected));
      });
    }
    for (const popover of this.element.querySelectorAll("[data-status-popover]")) {
      popover.addEventListener("toggle", () => {
        const trigger = popover.closest(".nontoken-combat-dashboard-status-menu")
          ?.querySelector("[data-action='toggleStatusMenu']");
        trigger?.setAttribute("aria-expanded", String(popover.matches(":popover-open")));
        const popoverCombatantId = popover.closest("[data-combatant-id]")?.dataset.combatantId;
        if (!popover.matches(":popover-open")
          && this.element.contains(popover)
          && popoverCombatantId === this.openStatusCombatantId) {
          this.openStatusCombatantId = null;
        }
      });
    }

    if (this.openStatusCombatantId) showStatusPopover(this, this.openStatusCombatantId);
  }

  async _prepareContext() {
    if (!game.user.isGM) {
      return { isGM: false, combatName: "", combatants: [], statuses: [], hasHealthSupported: false };
    }

    const combat = this.combat;
    const statuses = getConfiguredStatuses();
    const combatants = (combat?.combatants.contents ?? []).map((combatant) => {
      const actor = combatant.actor;
      const health = getHealthInfo(actor);
      const token = combatant.token;
      const statusButtons = statuses.map((status) => {
        const active = hasStatusEffect(combatant, status.id);
        return {
          ...status,
          active,
          ariaLabel: `${active ? "Quitar" : "Aplicar"} ${status.name}`
        };
      });
      const configuredStatusIds = new Set(statuses.map((status) => normalizeStatusId(status.id)));
      const extraActiveConditions = getActiveConditions(actor)
        .filter((condition) => !configuredStatusIds.has(normalizeStatusId(condition.id)))
        .map((condition) => ({
          ...condition,
          active: true,
          locked: true,
          ariaLabel: condition.name
        }));
      statusButtons.push(...extraActiveConditions);

      return {
        id: combatant.id,
        name: combatant.name,
        img: token?.texture?.src ?? actor?.prototypeToken?.texture?.src ?? actor?.img ?? "icons/svg/mystery-man.svg",
        initiative: combatant.initiative ?? "—",
        defeated: combatant.defeated,
        healthSupported: Boolean(health),
        healthValue: health?.value ?? "",
        healthMax: health?.max ?? "",
        statusButtons,
        selected: this.selectedCombatantIds.has(combatant.id)
      };
    });

    return {
      isGM: true,
      combatName: combat?.name || "Combate actual",
      hasCombatants: combatants.length > 0,
      hasHealthSupported: combatants.some((combatant) => combatant.healthSupported),
      combatants,
      statuses
    };
  }

  static #onToggleAll() {
    const checkboxes = [...this.element.querySelectorAll("input[name='combatantIds']")];
    const shouldSelect = checkboxes.some((checkbox) => !checkbox.checked);
    for (const checkbox of checkboxes) checkbox.checked = shouldSelect;
    this.selectedCombatantIds = new Set(shouldSelect ? checkboxes.map((checkbox) => checkbox.value) : []);
    this.element.querySelector("[data-action='toggleAll']")
      ?.setAttribute("aria-pressed", String(shouldSelect));
  }

  static async #onApplyBulkHealth() {
    if (!game.user.isGM) return;
    const amountInput = this.element.querySelector("[name='bulkHealthAmount']");
    const amount = Number(amountInput?.value);
    if (!amountInput?.value.trim() || !Number.isSafeInteger(amount) || amount <= 0) {
      ui.notifications.warn("Introduce una cantidad de puntos de vida entera mayor que cero.");
      return;
    }

    const selected = getSelectedCombatants(this);
    if (!selected.length) {
      ui.notifications.warn("Selecciona uno o más combatientes, o usa «Todos».");
      return;
    }

    const operation = this.element.querySelector("[name='bulkHealthOperation']")?.value;
    let updated = 0;
    for (const combatant of selected) {
      const health = getHealthInfo(combatant.actor);
      if (!health) continue;
      const nextValue = operation === "heal"
        ? health.value + amount
        : health.value - amount;
      await updateHealth(combatant.actor, health, nextValue);
      updated++;
    }

    if (!updated) {
      ui.notifications.warn("No se encontró una ruta de vida compatible en los combatientes seleccionados.");
    } else {
      const action = operation === "heal" ? "curación" : "daño";
      ui.notifications.info(`Se aplicó ${action} a ${updated} combatiente(s).`);
      this.selectedCombatantIds.clear();
      if (updated < selected.length) {
        ui.notifications.warn(`${selected.length - updated} combatiente(s) no tienen una ruta de vida compatible y se omitieron.`);
      }
    }
    await this.render(true);
  }

  static #onToggleStatusMenu(event, button) {
    const row = button.closest("[data-combatant-id]");
    const combatantId = row?.dataset.combatantId;
    const popover = row?.querySelector("[data-status-popover]");
    if (!combatantId || !popover) return;

    if (this.openStatusCombatantId === combatantId || popover.matches(":popover-open")) {
      closeStatusPopover(this);
      return;
    }

    closeStatusPopover(this);
    this.openStatusCombatantId = combatantId;
    showStatusPopover(this, combatantId);
  }

  static async #onSetHealth(event, button) {
    if (!game.user.isGM) return;
    const row = button.closest("[data-combatant-id]");
    const combatant = this.combat?.combatants.get(row?.dataset.combatantId);
    const input = row?.querySelector("[data-health-value]");
    const value = Number(input?.value);
    const health = getHealthInfo(combatant?.actor);
    if (!health || !Number.isFinite(value)) {
      ui.notifications.warn("No se pudo leer la vida de este actor.");
      return;
    }

    await updateHealth(combatant.actor, health, value);
    await this.render(true);
  }

  static async #onToggleStatus(event, button) {
    if (!game.user.isGM) return;
    const row = button.closest("[data-combatant-id]");
    const combatant = this.combat?.combatants.get(row?.dataset.combatantId);
    const statusId = button.dataset.statusId;
    const actor = combatant?.actor ?? combatant?.token?.actor;
    if (!actor || !statusId || typeof actor.toggleStatusEffect !== "function") {
      ui.notifications.warn("Foundry no pudo cambiar este estado en el combatiente.");
      return;
    }

    const toggleKey = `${combatant.id}:${statusId}`;
    if (statusTogglesInFlight.has(toggleKey)) return;
    this.openStatusCombatantId = combatant.id;
    statusTogglesInFlight.add(toggleKey);
    try {
      try {
        // Let Foundry/the system decide from its own status state; forcing active based on
        // TokenDocument.hasStatusEffect can be stale in some system-specific implementations.
        await actor.toggleStatusEffect(statusId);
      } catch (error) {
        console.error(`${MODULE_ID} | No se pudo alternar el estado ${statusId}.`, error);
        ui.notifications.error("No se pudo cambiar el estado del combatiente.");
      }
      await this.render(true);
    } finally {
      statusTogglesInFlight.delete(toggleKey);
    }
  }

  static async #onToggleDefeated(event, button) {
    if (!game.user.isGM) return;
    const row = button.closest("[data-combatant-id]");
    const combatant = this.combat?.combatants.get(row?.dataset.combatantId);
    if (!combatant) return;

    await this.combat.updateEmbeddedDocuments("Combatant", [
      { _id: combatant.id, defeated: !combatant.defeated }
    ]);
    await this.render(true);
  }
}

function getSelectedCombatants(app) {
  const ids = [...app.element.querySelectorAll("input[name='combatantIds']:checked")]
    .map((checkbox) => checkbox.value);
  return ids.map((id) => app.combat?.combatants.get(id)).filter(Boolean);
}

function showStatusPopover(app, combatantId) {
  const row = [...app.element.querySelectorAll("[data-combatant-id]")]
    .find((item) => item.dataset.combatantId === combatantId);
  const trigger = row?.querySelector("[data-action='toggleStatusMenu']");
  const popover = row?.querySelector("[data-status-popover]");
  if (!trigger || !popover) return;

  if (!popover.matches(":popover-open")) popover.showPopover();
  trigger.setAttribute("aria-expanded", "true");
  const anchor = trigger.getBoundingClientRect();
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
  const top = anchor.bottom + height + 8 <= window.innerHeight
    ? anchor.bottom + 6
    : Math.max(8, anchor.top - height - 6);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  installStatusPopoverDismissListeners(app);
}

function closeStatusPopover(app) {
  removeStatusPopoverDismissListeners(app);
  for (const popover of app.element.querySelectorAll("[data-status-popover]")) {
    if (!popover.matches(":popover-open")) continue;
    popover.hidePopover();
    popover.closest(".nontoken-combat-dashboard-status-menu")
      ?.querySelector("[data-action='toggleStatusMenu']")
      ?.setAttribute("aria-expanded", "false");
  }
  app.openStatusCombatantId = null;
}

function installStatusPopoverDismissListeners(app) {
  removeStatusPopoverDismissListeners(app);
  const pointerdown = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-status-popover], [data-action='toggleStatusMenu']")) return;
    closeStatusPopover(app);
  };
  const keydown = (event) => {
    if (event.key !== "Escape" || !app.openStatusCombatantId) return;
    event.preventDefault();
    event.stopPropagation();
    closeStatusPopover(app);
  };
  document.addEventListener("pointerdown", pointerdown, true);
  document.addEventListener("keydown", keydown, true);
  app.statusPopoverDismissListeners = { pointerdown, keydown };
}

function removeStatusPopoverDismissListeners(app) {
  const listeners = app.statusPopoverDismissListeners;
  if (!listeners) return;
  document.removeEventListener("pointerdown", listeners.pointerdown, true);
  document.removeEventListener("keydown", listeners.keydown, true);
  app.statusPopoverDismissListeners = null;
}

function getHealthInfo(actor) {
  if (!actor) return null;

  const candidates = [
    ["system.resources.hp.value", "system.resources.hp.max"],
    ["system.resources.hp.current", "system.resources.hp.max"],
    ["system.resources.health.value", "system.resources.health.max"],
    ["system.resources.health.current", "system.resources.health.max"],
    ["system.hp.current", "system.hp.max"],
    ["system.attributes.hp.value", "system.attributes.hp.max"],
    ["system.attributes.hp.current", "system.attributes.hp.max"],
    ["system.hp.value", "system.hp.max"],
    ["system.health.value", "system.health.max"],
    ["system.health.current", "system.health.max"],
    ["system.attributes.health.value", "system.attributes.health.max"]
  ];

  for (const [valuePath, maxPath] of candidates) {
    const health = readHealthPath(actor, valuePath, maxPath);
    if (health) return health;
  }

  return findHealthResource(actor, actor.system, "system");
}

function readHealthPath(actor, valuePath, maxPath) {
  const value = foundry.utils.getProperty(actor, valuePath);
  const max = foundry.utils.getProperty(actor, maxPath);
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return null;
  return {
    valuePath,
    value: Number(value),
    max: max === undefined || max === null || !Number.isFinite(Number(max)) ? null : Number(max)
  };
}

function findHealthResource(actor, data, path) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  for (const [key, resource] of Object.entries(data)) {
    const resourcePath = `${path}.${key}`;
    const normalizedKey = normalizeResourceKey(key);
    if (HEALTH_RESOURCE_NAMES.has(normalizedKey)) {
      if (resource && typeof resource === "object" && !Array.isArray(resource)) {
        const fields = Object.entries(resource);
        const current = fields.find(([field, value]) => HEALTH_CURRENT_NAMES.has(normalizeResourceKey(field))
          && isFiniteResourceValue(value));
        if (current) {
          const max = fields.find(([field, value]) => HEALTH_MAX_NAMES.has(normalizeResourceKey(field))
            && isFiniteResourceValue(value));
          return {
            valuePath: `${resourcePath}.${current[0]}`,
            value: Number(current[1]),
            max: max ? Number(max[1]) : null
          };
        }
      }
    }

    const nested = findHealthResource(actor, resource, resourcePath);
    if (nested) return nested;
  }
  return null;
}

function normalizeResourceKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isFiniteResourceValue(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

async function updateHealth(actor, health, nextValue) {
  const lowerBounded = Math.max(0, Number(nextValue));
  const value = health.max === null ? lowerBounded : Math.min(health.max, lowerBounded);
  await actor.update({ [health.valuePath]: value });
}

function hasStatusEffect(combatant, statusId) {
  const token = combatant?.token;
  const actor = combatant?.actor ?? token?.actor;
  if (statusId === "dead" && actor?.statuses?.has?.("dead")) return true;
  if (typeof actor?.hasCondition === "function") return Boolean(actor.hasCondition(statusId));

  const systemCondition = actor?.getCondition?.(statusId);
  if (systemCondition) {
    const active = systemCondition.active ?? systemCondition.system?.active;
    const value = systemCondition.value ?? systemCondition.system?.value?.value;
    return active !== false && value !== 0;
  }
  if (actor?.statuses?.has?.(statusId)) return true;
  const normalizedStatusId = normalizeStatusId(statusId);
  if ([...(actor?.statuses ?? [])].some((status) => normalizeStatusId(status) === normalizedStatusId)) return true;

  const activeEffect = actor?.effects?.contents?.some((effect) => {
    if (effect.disabled) return false;
    const effectStatuses = [...(effect.statuses ?? [])];
    const hasStatus = effectStatuses.some((status) => normalizeStatusId(status) === normalizedStatusId);
    return hasStatus || normalizeStatusId(effect.getFlag?.("core", "statusId")) === normalizedStatusId;
  });
  if (activeEffect) return true;

  if (getActiveConditions(actor).some((condition) => normalizeStatusId(condition.id) === normalizedStatusId)) {
    return true;
  }

  return false;
}

function getActiveConditions(actor) {
  return (actor?.items?.contents ?? [])
    .filter((item) => item.type === "condition" && item.system?.active !== false)
    .filter((item) => {
      const value = item.system?.value?.value ?? item.system?.value;
      return value === undefined || value === null || !Number.isFinite(Number(value)) || Number(value) > 0;
    })
    .map((item) => ({
      id: item.system?.slug ?? item.id,
      name: item.name,
      img: item.img ?? "icons/svg/aura.svg"
    }))
    .filter((condition) => condition.id && condition.name);
}

function normalizeStatusId(statusId) {
  return String(statusId ?? "").toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

function getConfiguredStatuses() {
  const configured = CONFIG.statusEffects;
  const statuses = Array.isArray(configured) ? configured : Object.values(configured ?? {});
  return statuses.map((status) => ({
    id: status.id ?? status.statusId ?? status.name,
    name: game.i18n.localize(status.name ?? status.label ?? status.id ?? "Efecto"),
    img: status.icon ?? status.img ?? "icons/svg/aura.svg"
  })).filter((status) => status.id);
}

export function openCombatDashboard(combat = game.combat) {
  if (!game.user.isGM) {
    ui.notifications.warn("El panel de combate solo está disponible para el GM.");
    return null;
  }
  if (!combat) {
    ui.notifications.warn("No hay ningún combate disponible.");
    return null;
  }

  return new NonTokenCombatDashboard(combat.id).render(true);
}

export async function refreshCombatDashboards(actor) {
  if (!actor) return;
  const actorId = actor.id;
  await renderCombatDashboards((dashboard) => dashboard.combat?.combatants.contents.some((combatant) =>
    combatant.actorId === actorId || combatant.actor?.id === actorId
  ));
}

export async function refreshCombatDashboardsForCombat(combat) {
  if (!combat) return;
  await renderCombatDashboards((dashboard) => dashboard.combatId === combat.id);
}

export async function closeCombatDashboardsForCombat(combat) {
  if (!combat) return;
  const closing = [];
  for (const dashboard of combatDashboards) {
    if (dashboard.combatId !== combat.id) continue;
    closeStatusPopover(dashboard);
    closing.push(dashboard.close());
    combatDashboards.delete(dashboard);
  }
  await Promise.all(closing);
}

async function renderCombatDashboards(shouldRender) {
  const updates = [];
  for (const dashboard of combatDashboards) {
    if (!dashboard.element?.isConnected) {
      combatDashboards.delete(dashboard);
      continue;
    }
    if (shouldRender(dashboard)) updates.push(dashboard.render(true));
  }
  await Promise.all(updates);
}
