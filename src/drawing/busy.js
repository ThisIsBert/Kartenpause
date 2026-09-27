// Independent owners prevent one completed task from clearing another's cursor.
const owners = new Set();
export function setBusy(owner, value) {
  if (value) owners.add(owner); else owners.delete(owner);
  document.documentElement.classList.toggle('app-busy', owners.size > 0);
  document.getElementById('drawingSidebar')?.setAttribute('aria-busy', String(owners.size > 0));
}
