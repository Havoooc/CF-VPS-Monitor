import { createRouteStore } from './routeStore.js';

const store = createRouteStore({
  keyPrefix: 'forward_route:',
  invalidError: 'invalidForwardRoutes',
  invalidDateError: 'invalidForwardRouteDate'
});

export const normalizeForwardRoutes = store.normalize;
export const getForwardRoutes = store.getAll;
export const saveForwardRoutes = store.save;
