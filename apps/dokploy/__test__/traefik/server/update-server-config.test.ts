import { fs, vol } from "memfs";

vi.mock("node:fs", () => ({
	...fs,
	default: fs,
}));

import type { Admin } from "@/server/api/services/admin";
import { createDefaultServerTraefikConfig, createDefaultTraefikConfig, updateTraefikConfig } from "@/server/setup/traefik-setup";
import { loadOrCreateConfig } from "@/server/utils/traefik/application";
import type { FileConfig } from "@/server/utils/traefik/file-types";
import { updateServerTraefik } from "@/server/utils/traefik/web-server";
import { beforeEach, expect, test, vi } from "vitest";
import path from "node:path";
import { MAIN_TRAEFIK_PATH } from "@/server/constants";
import * as Yaml from "js-yaml"
import { MainTraefikConfig } from "@/server/utils/traefik/types";

const baseAdmin: Admin = {
	createdAt: "",
	authId: "",
	adminId: "string",
	serverIp: null,
	certificateType: "none",
	host: null,
	letsEncryptEmail: null,
	sshPrivateKey: null,
	enableDockerCleanup: false,
	enableLogRotation: false,
};

beforeEach(() => {
	vol.reset();
	createDefaultServerTraefikConfig();
});

test("Should read the configuration file", () => {
	const config: FileConfig = loadOrCreateConfig("dokploy");

	expect(config.http?.routers?.["dokploy-router-app"]?.service).toBe(
		"dokploy-service-app",
	);
});

test("Should apply redirect-to-https", () => {
	updateServerTraefik(
		{
			...baseAdmin,
			certificateType: "letsencrypt",
		},
		"example.com",
	);

	const config: FileConfig = loadOrCreateConfig("dokploy");

	expect(config.http?.routers?.["dokploy-router-app"]?.middlewares).toContain(
		"redirect-to-https",
	);
});

test("Should change only host when no certificate", () => {
	updateServerTraefik(baseAdmin, "example.com");

	const config: FileConfig = loadOrCreateConfig("dokploy");

	expect(config.http?.routers?.["dokploy-router-app-secure"]).toBeUndefined();
});

test("Should not touch config without host", () => {
	const originalConfig: FileConfig = loadOrCreateConfig("dokploy");

	updateServerTraefik(baseAdmin, null);

	const config: FileConfig = loadOrCreateConfig("dokploy");

	expect(originalConfig).toEqual(config);
});

test("Should remove websecure if https rollback to http", () => {
	const originalConfig: FileConfig = loadOrCreateConfig("dokploy");

	updateServerTraefik(
		{ ...baseAdmin, certificateType: "letsencrypt" },
		"example.com",
	);

	updateServerTraefik({ ...baseAdmin, certificateType: "none" }, "example.com");

	const config: FileConfig = loadOrCreateConfig("dokploy");

	expect(config.http?.routers?.["dokploy-router-app-secure"]).toBeUndefined();
	expect(
		config.http?.routers?.["dokploy-router-app"]?.middlewares,
	).not.toContain("redirect-to-https");
});

test("Should enable and disable HTTP/3 enabled in entrypoint", () => {
	const mainConfig = path.join(MAIN_TRAEFIK_PATH, "traefik.yml");
	expect(fs.existsSync(mainConfig)).toEqual(false)

	createDefaultTraefikConfig(true)
	expect(fs.existsSync(mainConfig)).toEqual(true)

	let configData = fs.readFileSync(mainConfig)
	let config = String(configData)
	let yml = Yaml.load(config) as MainTraefikConfig
	expect(yml?.["entryPoints"]?.["websecure"]?.["http3"]?.["advertisedPort"]).equal(443)

	updateTraefikConfig(false)
	expect(fs.existsSync(mainConfig)).toEqual(true)
	configData = fs.readFileSync(mainConfig)
	config = String(configData)
	yml = Yaml.load(config) as MainTraefikConfig
	expect(yml?.["entryPoints"]?.["websecure"]?.["http3"]).toBeUndefined()
});