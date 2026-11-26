/** Writes a local Max activation for manual runs: `npx tsx test/helpers/dev-license.ts <home>` prints env to use. */
import { machineFingerprint } from "../../src/license/fingerprint.js";
import { writeState } from "../../src/license/store.js";
import { testAuthority } from "./license.js";

const plan = (process.argv[2] ?? "max") as "plus" | "pro" | "max";
const a = testAuthority();
const lic = a.license(plan);
const lid = JSON.parse(Buffer.from(lic.split(".")[1]!, "base64url").toString()).lid as string;
writeState({ license: lic, activation: a.activation(lid, machineFingerprint(), plan), machineId: "m1", machineLabel: "dev", activatedAt: new Date().toISOString(), lastCheck: new Date().toISOString() });
process.stdout.write(a.publicKeys);
