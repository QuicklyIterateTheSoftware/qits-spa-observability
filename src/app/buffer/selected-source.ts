import { computed, inject, type Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, convertToParamMap } from '@angular/router';

/**
 * The query parameter every screen in this SPA carries.
 *
 * The selected source decides which bucket every read addresses, so it costs a request — and by the
 * house rule anything that costs a request is URL state, not component state. That is what makes
 * every screen here a shareable link and what makes the back button mean "the source I had before".
 */
export const SOURCE_PARAM = 'source';

/**
 * The selected source key, as a signal, or null when none is chosen.
 *
 * The key is **opaque**. It comes from the sources listing and goes back on the wire verbatim;
 * nothing in this application builds one, parses one, or reads meaning out of one. It happens to be
 * spelled `_service/qits-ci` today and that is not a promise.
 *
 * A helper rather than four copies of the same three lines, because every screen needs exactly this
 * and a screen that quietly dropped it would not look broken — a request with no source answers
 * `200` and an empty list, which draws as "no telemetry".
 *
 * Must be called in an injection context: it reads the route the caller is mounted on.
 */
export function selectedSource(): Signal<string | null> {
  const route = inject(ActivatedRoute);
  const params = toSignal(route.queryParamMap, { initialValue: convertToParamMap({}) });
  return computed(() => params().get(SOURCE_PARAM));
}
