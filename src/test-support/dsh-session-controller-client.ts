import { loadOfficialClientModule } from "./dsh-browser-modules.js";

const controller = loadOfficialClientModule("@deepseek-ai/dsh-api-session-controller/client");

export const MutableSessionEventSource = controller.MutableSessionEventSource;
export const SESSION_SEARCH_RESULT_LIMIT = controller.SESSION_SEARCH_RESULT_LIMIT;
export const SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS =
  controller.SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS;
export const SessionCreateError = controller.SessionCreateError;
export const SessionEventStream = controller.SessionEventStream;
export const SessionForkError = controller.SessionForkError;
export const apply = controller.apply;
export const createScope = controller.createScope;
export const createSessionControlStream = controller.createSessionControlStream;
export const inject = controller.inject;
export const scopeOf = controller.scopeOf;
