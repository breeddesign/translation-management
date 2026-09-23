import { startWeb } from "./app.js";
import { startWorkers } from "./worker-runtime.js";
import { config } from "./config.js";

export interface DesktopRuntime {
  port: number;
  url: string;
  close(): Promise<void>;
}

/**
 * Startet Web-Server und Job-Worker im selben Prozess — die Desktop-App
 * braucht weder zwei Prozesse noch Docker, Redis oder MySQL.
 *
 * Port 0 bedeutet: freien Port vom Betriebssystem wählen lassen, damit eine
 * parallel laufende Server-Instanz nicht kollidiert.
 */
export async function startDesktopRuntime(port = 0): Promise<DesktopRuntime> {
  if (!config.isDesktop) {
    console.warn(`⚠️  APP_MODE ist "${config.mode}" — Desktop-Laufzeit erwartet APP_MODE=desktop`);
  }

  const web = await startWeb(port);
  const workers = await startWorkers();

  return {
    port: web.port,
    url: `http://localhost:${web.port}`,
    async close() {
      await workers.close();
      await web.close();
    },
  };
}
