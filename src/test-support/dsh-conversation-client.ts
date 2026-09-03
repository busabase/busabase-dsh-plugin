import { loadOfficialClientModule } from "./dsh-browser-modules.js";

const conversation = loadOfficialClientModule("@deepseek-ai/dsh-client-ui-conversation/client");

export const apply = conversation.apply;
export const inject = conversation.inject;
