import { loadOfficialClientModule } from "./dsh-browser-modules.js";

const runtime = loadOfficialClientModule("@deepseek-ai/dsh-client-runtime/client");

export const ConversationEventRegistry = runtime.ConversationEventRegistry;
export const ConversationViewRegistry = runtime.ConversationViewRegistry;
export const EMPTY_CHAT_SNAPSHOT = runtime.EMPTY_CHAT_SNAPSHOT;
export const EMPTY_CONVERSATION_VIEWS = runtime.EMPTY_CONVERSATION_VIEWS;
export const SessionProvideChannel = runtime.SessionProvideChannel;
export const SlotRegistry = runtime.SlotRegistry;
export const createScope = runtime.createScope;
export const createSnapshotStore = runtime.createSnapshotStore;
export const scopeOf = runtime.scopeOf;
