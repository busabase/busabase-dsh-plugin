import { loadOfficialClientModule } from "./dsh-browser-modules.js";

const renderer = loadOfficialClientModule("@deepseek-ai/dsh-client-ui-renderer/client");

export const bindSnapshotSelector = renderer.bindSnapshotSelector;
export const createSlotRenderer = renderer.createSlotRenderer;
export const SlotRegistry = renderer.SlotRegistry;
export const apply = renderer.apply;
export const inject = renderer.inject;
