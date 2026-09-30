import { loadOfficialClientModule } from "./dsh-browser-modules.js";

const session = loadOfficialClientModule("@deepseek-ai/dsh-client-ui-session/client");

export const apply = session.apply;
export const inject = session.inject;
