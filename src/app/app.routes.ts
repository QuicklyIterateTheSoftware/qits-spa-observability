import type { Routes } from '@angular/router';
import { QitsMainLayout } from '@qits/ui-components';

/**
 * One route, and it is the chrome. `QitsMainLayout` sits at `''` as a *component* route rather
 * than inside the shell's template so the sidebar and top bar are rendered once and then left
 * alone — every page this SPA grows arrives as a child beneath it, swapping only the inner outlet.
 *
 * `children` is empty on purpose: the observability pages are not written yet, and this is the
 * hook they attach to when they are.
 */
export const routes: Routes = [{ path: '', component: QitsMainLayout, children: [] }];
