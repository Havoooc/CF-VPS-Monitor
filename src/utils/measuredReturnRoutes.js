import { createRouteStore } from './routeStore.js';

const store = createRouteStore({
  keyPrefix: 'return_snapshot:',
  invalidError: 'invalidMeasuredReturnRoutes',
  invalidDateError: 'invalidMeasuredReturnRoutesDate'
});

export const normalizeMeasuredReturnRoutes = store.normalize;
export const getMeasuredReturnRoutes = store.getAll;
export const saveMeasuredReturnRoutes = store.save;
