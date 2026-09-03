import { loadOfficialClientModule } from "./dsh-browser-modules.js";

const locale = loadOfficialClientModule("@deepseek-ai/dsh-client-locale/client");

export const LocaleRuntime = locale.LocaleRuntime;
