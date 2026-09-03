import { loadOfficialClientModule } from "./dsh-browser-modules.js";

const tool = loadOfficialClientModule("@deepseek-ai/dsh-client-ui-tool/client");

export const apply = tool.apply;
export const inject = tool.inject;
