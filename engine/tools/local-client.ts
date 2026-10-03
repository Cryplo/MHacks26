import { execFileSync } from "node:child_process";
import { Client } from "../client/index.js";
export function operatorConfig() {
  let token = process.env.SPACETIME_OPERATOR_TOKEN;
  if (!token) {
    const captured = execFileSync(
      process.env.SPACETIME_CLI ?? "spacetime",
      ["login", "show", "--token"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    token = captured.match(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
    )?.[0];
  }
  if (!token)
    throw new Error(
      "Log in to the local SpacetimeDB server or set SPACETIME_OPERATOR_TOKEN.",
    );
  return {
    uri: process.env.SPACETIME_URI ?? "http://127.0.0.1:3000",
    database: process.env.SPACETIME_DATABASE ?? "mhacks-engine",
    token,
  };
}
export async function localOperator() {
  const c = new Client(operatorConfig());
  await c.connect();
  return c;
}
