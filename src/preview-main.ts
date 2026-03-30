import "./app.css";
import { startApp } from "./lib/app-start";
import { installBrowserPreviewRuntime } from "./lib/preview/runtime";

installBrowserPreviewRuntime();

const app = startApp();

export default app;
