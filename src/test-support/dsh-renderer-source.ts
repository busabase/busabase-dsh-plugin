import { loadOfficialClientModule } from "./dsh-browser-modules.js";

const renderer = loadOfficialClientModule("@deepseek-ai/dsh-client-ui-renderer/client");

export const bindSnapshotSelector = renderer.bindSnapshotSelector;
export const createSlotRenderer = renderer.createSlotRenderer;
