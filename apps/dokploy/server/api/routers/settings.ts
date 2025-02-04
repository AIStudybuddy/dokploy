import { MAIN_TRAEFIK_PATH, MONITORING_PATH } from "@/server/constants";
import {
	apiAssignDomain,
	apiEnableDashboard,
	apiEnableHTTP3,
	apiModifyTraefikConfig,
	apiReadStatsLogs,
	apiReadTraefikConfig,
	apiSaveSSHKey,
	apiTraefikConfig,
	apiUpdateDockerCleanup,
} from "@/server/db/schema";
import { createDefaultTraefikConfig, initializeTraefik, updateTraefikConfig } from "@/server/setup/traefik-setup";
import { logRotationManager } from "@/server/utils/access-log/handler";
import { parseRawConfig, processLogs } from "@/server/utils/access-log/utils";
import {
	cleanStoppedContainers,
	cleanUpDockerBuilder,
	cleanUpSystemPrune,
	cleanUpUnusedImages,
	cleanUpUnusedVolumes,
	prepareEnvironmentVariables,
	startService,
	stopService,
} from "@/server/utils/docker/utils";
import { recreateDirectory } from "@/server/utils/filesystem/directory";
import { sendDockerCleanupNotifications } from "@/server/utils/notifications/docker-cleanup";
import { execAsync } from "@/server/utils/process/execAsync";
import { spawnAsync } from "@/server/utils/process/spawnAsync";
import {
	readConfig,
	readConfigInPath,
	readMonitoringConfig,
	writeConfig,
	writeTraefikConfigInPath,
} from "@/server/utils/traefik/application";
import {
	readMainConfig,
	updateLetsEncryptEmail,
	updateServerTraefik,
	writeMainConfig,
} from "@/server/utils/traefik/web-server";
import { generateOpenApiDocument } from "@dokploy/trpc-openapi";
import { TRPCError } from "@trpc/server";
import { dump, load } from "js-yaml";
import { scheduleJob, scheduledJobs } from "node-schedule";
import { z } from "zod";
import { appRouter } from "../root";
import { findAdmin, updateAdmin } from "../services/admin";
import {
	getDokployImage,
	getDokployVersion,
	pullLatestRelease,
	readDirectory,
} from "../services/settings";
import { canAccessToTraefikFiles } from "../services/user";
import { adminProcedure, createTRPCRouter, protectedProcedure } from "../trpc";
import { create } from "lodash";
import type{ PortConfig } from "dockerode";

export const settingsRouter = createTRPCRouter({
	reloadServer: adminProcedure.mutation(async () => {
		const { stdout } = await execAsync(
			"docker service inspect dokploy --format '{{.ID}}'",
		);
		await execAsync(`docker service update --force ${stdout.trim()}`);
		return true;
	}),
	reloadTraefik: adminProcedure.mutation(async () => {
		try {
			await stopService("dokploy-traefik");
			await startService("dokploy-traefik");
		} catch (err) {
			console.error(err);
		}

		return true;
	}),
	toggleDashboard: adminProcedure
		.input(apiEnableDashboard)
		.mutation(async ({ input }) => {
			await initializeTraefik({
				enableDashboard: input.enableDashboard,
			});
			return true;
		}),

	toggleHTTP3: adminProcedure
		.input(apiEnableHTTP3)
		.mutation(async ({ input }) => {
			updateTraefikConfig(input.enableHTTP3)
			await initializeTraefik({
				enableHTTP3: input.enableHTTP3,
			});
			return true;
		}),

	cleanUnusedImages: adminProcedure.mutation(async () => {
		await cleanUpUnusedImages();
		return true;
	}),
	cleanUnusedVolumes: adminProcedure.mutation(async () => {
		await cleanUpUnusedVolumes();
		return true;
	}),
	cleanStoppedContainers: adminProcedure.mutation(async () => {
		await cleanStoppedContainers();
		return true;
	}),
	cleanDockerBuilder: adminProcedure.mutation(async () => {
		await cleanUpDockerBuilder();
	}),
	cleanDockerPrune: adminProcedure.mutation(async () => {
		await cleanUpSystemPrune();
		await cleanUpDockerBuilder();

		return true;
	}),
	cleanAll: adminProcedure.mutation(async () => {
		await cleanUpUnusedImages();
		await cleanUpDockerBuilder();
		await cleanUpSystemPrune();

		return true;
	}),
	cleanMonitoring: adminProcedure.mutation(async () => {
		await recreateDirectory(MONITORING_PATH);
		return true;
	}),
	saveSSHPrivateKey: adminProcedure
		.input(apiSaveSSHKey)
		.mutation(async ({ input, ctx }) => {
			await updateAdmin(ctx.user.authId, {
				sshPrivateKey: input.sshPrivateKey,
			});

			return true;
		}),
	assignDomainServer: adminProcedure
		.input(apiAssignDomain)
		.mutation(async ({ ctx, input }) => {
			const admin = await updateAdmin(ctx.user.authId, {
				host: input.host,
				letsEncryptEmail: input.letsEncryptEmail,
				certificateType: input.certificateType,
			});

			if (!admin) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Admin not found",
				});
			}

			updateServerTraefik(admin, input.host);
			updateLetsEncryptEmail(admin.letsEncryptEmail);
			return admin;
		}),
	cleanSSHPrivateKey: adminProcedure.mutation(async ({ ctx }) => {
		await updateAdmin(ctx.user.authId, {
			sshPrivateKey: null,
		});
		return true;
	}),
	updateDockerCleanup: adminProcedure
		.input(apiUpdateDockerCleanup)
		.mutation(async ({ input, ctx }) => {
			await updateAdmin(ctx.user.authId, {
				enableDockerCleanup: input.enableDockerCleanup,
			});

			const admin = await findAdmin();

			if (admin.enableDockerCleanup) {
				scheduleJob("docker-cleanup", "0 0 * * *", async () => {
					console.log(
						`Docker Cleanup ${new Date().toLocaleString()}] Running...`,
					);
					await cleanUpUnusedImages();
					await cleanUpDockerBuilder();
					await cleanUpSystemPrune();
					await sendDockerCleanupNotifications();
				});
			} else {
				const currentJob = scheduledJobs["docker-cleanup"];
				currentJob?.cancel();
			}

			return true;
		}),

	readTraefikConfig: adminProcedure.query(() => {
		const traefikConfig = readMainConfig();
		return traefikConfig;
	}),

	updateTraefikConfig: adminProcedure
		.input(apiTraefikConfig)
		.mutation(async ({ input }) => {
			writeMainConfig(input.traefikConfig);
			return true;
		}),

	readWebServerTraefikConfig: adminProcedure.query(() => {
		const traefikConfig = readConfig("dokploy");
		return traefikConfig;
	}),
	updateWebServerTraefikConfig: adminProcedure
		.input(apiTraefikConfig)
		.mutation(async ({ input }) => {
			writeConfig("dokploy", input.traefikConfig);
			return true;
		}),

	readMiddlewareTraefikConfig: adminProcedure.query(() => {
		const traefikConfig = readConfig("middlewares");
		return traefikConfig;
	}),

	updateMiddlewareTraefikConfig: adminProcedure
		.input(apiTraefikConfig)
		.mutation(async ({ input }) => {
			writeConfig("middlewares", input.traefikConfig);
			return true;
		}),

	checkAndUpdateImage: adminProcedure.mutation(async () => {
		return await pullLatestRelease();
	}),
	updateServer: adminProcedure.mutation(async () => {
		await spawnAsync("docker", [
			"service",
			"update",
			"--force",
			"--image",
			getDokployImage(),
			"dokploy",
		]);
		return true;
	}),

	getDokployVersion: adminProcedure.query(() => {
		return getDokployVersion();
	}),
	readDirectories: protectedProcedure.query(async ({ ctx }) => {
		if (ctx.user.rol === "user") {
			const canAccess = await canAccessToTraefikFiles(ctx.user.authId);

			if (!canAccess) {
				throw new TRPCError({ code: "UNAUTHORIZED" });
			}
		}
		const result = readDirectory(MAIN_TRAEFIK_PATH);
		return result || [];
	}),

	updateTraefikFile: protectedProcedure
		.input(apiModifyTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			if (ctx.user.rol === "user") {
				const canAccess = await canAccessToTraefikFiles(ctx.user.authId);

				if (!canAccess) {
					throw new TRPCError({ code: "UNAUTHORIZED" });
				}
			}
			writeTraefikConfigInPath(input.path, input.traefikConfig);
			return true;
		}),

	readTraefikFile: protectedProcedure
		.input(apiReadTraefikConfig)
		.query(async ({ input, ctx }) => {
			if (ctx.user.rol === "user") {
				const canAccess = await canAccessToTraefikFiles(ctx.user.authId);

				if (!canAccess) {
					throw new TRPCError({ code: "UNAUTHORIZED" });
				}
			}
			return readConfigInPath(input.path);
		}),
	getIp: protectedProcedure.query(async () => {
		const admin = await findAdmin();
		return admin.serverIp;
	}),

	getOpenApiDocument: protectedProcedure.query(
		async ({ ctx }): Promise<unknown> => {
			const protocol = ctx.req.headers["x-forwarded-proto"];
			const url = `${protocol}://${ctx.req.headers.host}/api`;
			const openApiDocument = generateOpenApiDocument(appRouter, {
				title: "tRPC OpenAPI",
				version: "1.0.0",
				baseUrl: url,
				docsUrl: `${url}/settings.getOpenApiDocument`,
				tags: [
					"admin",
					"docker",
					"compose",
					"registry",
					"cluster",
					"user",
					"domain",
					"destination",
					"backup",
					"deployment",
					"mounts",
					"certificates",
					"settings",
					"security",
					"redirects",
					"port",
					"project",
					"application",
					"mysql",
					"postgres",
					"redis",
					"mongo",
					"mariadb",
					"sshRouter",
					"gitProvider",
					"bitbucket",
					"github",
					"gitlab",
				],
			});

			openApiDocument.info = {
				title: "Dokploy API",
				description: "Endpoints for dokploy",
				version: getDokployVersion(),
			};

			return openApiDocument;
		},
	),
	readTraefikEnv: adminProcedure.query(async () => {
		const { stdout } = await execAsync(
			"docker service inspect --format='{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' dokploy-traefik",
		);

		return stdout.trim();
	}),

	writeTraefikEnv: adminProcedure
		.input(z.object({ env: z.string() }))
		.mutation(async ({ input }) => {
			const envs = prepareEnvironmentVariables(input.env);
			await initializeTraefik({
				env: envs,
			});

			return true;
		}),
	haveTraefikDashboardPortEnabled: adminProcedure.query(async () => {
		const { stdout } = await execAsync(
			"docker service inspect --format='{{json .Endpoint.Ports}}' dokploy-traefik",
		);

		const parsed: PortConfig[] = JSON.parse(stdout.trim());

		for (const port of parsed) {
			if (port.PublishedPort === 8080) {
				return true;
			}
		}

		return false;
	}),
	haveTraefikHTTP3Enabled: adminProcedure.query(async () => {
		const { stdout } = await execAsync(
			"docker service inspect --format='{{json .Endpoint.Ports}}' dokploy-traefik",
		);

		const parsed: PortConfig[] = JSON.parse(stdout.trim());

		for (const port of parsed) {
			if (port.Protocol === "udp" && port.PublishedPort === 443) {
				return true;
			}
		}

		return false;
	}),

	readStatsLogs: adminProcedure.input(apiReadStatsLogs).query(({ input }) => {
		const rawConfig = readMonitoringConfig();
		const parsedConfig = parseRawConfig(
			rawConfig as string,
			input.page,
			input.sort,
			input.search,
			input.status,
		);

		return parsedConfig;
	}),
	readStats: adminProcedure.query(() => {
		const rawConfig = readMonitoringConfig();
		const processedLogs = processLogs(rawConfig as string);
		return processedLogs || [];
	}),
	getLogRotateStatus: adminProcedure.query(async () => {
		return await logRotationManager.getStatus();
	}),
	toggleLogRotate: adminProcedure
		.input(
			z.object({
				enable: z.boolean(),
			}),
		)
		.mutation(async ({ input }) => {
			if (input.enable) {
				await logRotationManager.activate();
			} else {
				await logRotationManager.deactivate();
			}

			return true;
		}),
	haveActivateRequests: adminProcedure.query(async () => {
		const config = readMainConfig();

		if (!config) return false;
		const parsedConfig = load(config) as {
			accessLog?: {
				filePath: string;
			};
		};

		return !!parsedConfig?.accessLog?.filePath;
	}),
	toggleRequests: adminProcedure
		.input(
			z.object({
				enable: z.boolean(),
			}),
		)
		.mutation(async ({ input }) => {
			const mainConfig = readMainConfig();
			if (!mainConfig) return false;

			const currentConfig = load(mainConfig) as {
				accessLog?: {
					filePath: string;
				};
			};

			if (input.enable) {
				const config = {
					accessLog: {
						filePath: "/etc/dokploy/traefik/dynamic/access.log",
						format: "json",
						bufferingSize: 100,
						filters: {
							retryAttempts: true,
							minDuration: "10ms",
						},
					},
				};
				currentConfig.accessLog = config.accessLog;
			} else {
				currentConfig.accessLog = undefined;
			}

			writeMainConfig(dump(currentConfig));

			return true;
		}),
});
