// Shared layout controls; map sizing follows the workspace ResizeObserver.
export function setupWorkspace() {
  const rail = document.getElementById('toolRail');
  function positionTooltip() {
    const railRect = rail.getBoundingClientRect();
    for (const button of rail.querySelectorAll('.tool-button')) {
      const tooltip = button.querySelector('.tool-tooltip');
      if (!tooltip) continue;
      const rect = button.getBoundingClientRect();
      tooltip.hidden = rect.bottom <= railRect.top || rect.top >= railRect.bottom;
      tooltip.style.left = `${railRect.right + 8}px`;
      tooltip.style.top = `${Math.max(20, Math.min(window.innerHeight - 20, rect.top + rect.height / 2))}px`;
    }
  }
  rail.addEventListener('pointerover', positionTooltip);
  rail.addEventListener('focusin', positionTooltip);
  rail.addEventListener('scroll', () => positionTooltip());
  window.addEventListener('resize', positionTooltip);
  // Keep wheel gestures in the inspector, including inertial events that reach
  // the map immediately after the pointer leaves a scroll boundary.
  let sidebarWheelAt = -Infinity;
  document.addEventListener('wheel', event => {
    const now = performance.now();
    if (event.target.closest('#sidebar, #drawingSidebar, #geoSidebar, #toolRail')) {
      sidebarWheelAt = now;
    } else if (event.target.closest('#workspace') && now - sidebarWheelAt < 220) {
      sidebarWheelAt = now;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, { capture: true, passive: false });
  const separator = document.getElementById('sidebarResize');
  let dragging = false;
  function setWidth(width) {
    const maximum = window.innerWidth <= 1000 ? 300 : Math.min(600, Math.max(280, window.innerWidth - 380));
    width = Math.round(Math.max(280, Math.min(maximum, width)));
    document.body.style.setProperty('--sidebar-width', `${width}px`);
    separator.setAttribute('aria-valuenow', String(width));
    separator.setAttribute('aria-valuemax', String(maximum));
  }
  separator.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    dragging = true;
    separator.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  separator.addEventListener('pointermove', event => {
    if (dragging) setWidth(window.innerWidth - event.clientX);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    separator.addEventListener(name, () => { dragging = false; });
  }
  separator.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const width = Number(separator.getAttribute('aria-valuenow'));
    setWidth(event.key === 'Home' ? 280 : event.key === 'End' ? 600 : width + (event.key === 'ArrowLeft' ? 20 : -20));
  });
  window.addEventListener('resize', () => setWidth(Number(separator.getAttribute('aria-valuenow'))));
  setWidth(360);
}
