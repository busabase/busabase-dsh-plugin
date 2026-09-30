import { loadOfficialClientModule } from "./dsh-browser-modules.js";

const chat = loadOfficialClientModule("@deepseek-ai/dsh-client-ui-chat/client");

export const EMPTY_CHAT_SNAPSHOT = chat.EMPTY_CHAT_SNAPSHOT;

export const apply = chat.apply;
export const inject = chat.inject;
