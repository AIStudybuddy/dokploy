import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContainerTaskSpec, CreateServiceOptions } from "dockerode";
import { dump } from "js-yaml";
import { DYNAMIC_TRAEFIK_PATH, MAIN_TRAEFIK_PATH, docker } from "../constants";
import { pullImage } from "../utils/docker/utils";
import type { FileConfig } from "../utils/traefik/file-types";
import type { MainTraefikConfig } from "../utils/traefik/types";

const TRAEFIK_SSL_PORT =
	Number.parseInt(process.env.TRAEFIK_SSL_PORT ?? "", 10) || 443;
const TRAEFIK_PORT = Number.parseInt(process.env.TRAEFIK_PORT ?? "", 10) || 80;

interface TraefikOptions {
	enableDashboard?: boolean;
	enableHTTP3?: boolean
	env?: string[];
}

export const initializeTraefik = async ({
	enableDashboard = false,
	enableHTTP3 = false,
	env,
}: TraefikOptions = {}) => {
	const imageName = "traefik:v3.1.2";
	const containerName = "dokploy-traefik";
	const settings: CreateServiceOptions = {
		Name: containerName,
		TaskTemplate: {
			ContainerSpec: {
				Image: imageName,
				Env: env,
				Mounts: [
					{
						Type: "bind",
						Source: `${MAIN_TRAEFIK_PATH}/traefik.yml`,
						Target: "/etc/traefik/traefik.yml",
					},
					{
						Type: "bind",
						Source: DYNAMIC_TRAEFIK_PATH,
						Target: "/etc/dokploy/traefik/dynamic",
					},
					{
						Type: "bind",
						Source: "/var/run/docker.sock",
						Target: "/var/run/docker.sock",
					},
				],
			},
			Networks: [{ Target: "dokploy-network" }],
			Placement: {
				Constraints: ["node.role==manager"],
			},
		},
		Mode: {
			Replicated: {
				Replicas: 1,
			},
		},
		Labels: {
			"traefik.enable": "true",
		},
		EndpointSpec: {
			Ports: [
				...(
					enableHTTP3 ? (
					[
						{
							TargetPort: 443,
							PublishedPort: TRAEFIK_SSL_PORT,
							PublishMode: "host",
							Protocol : "udp"
						} as const
					]) : []
				),
				{
					TargetPort: 443,
					PublishedPort: TRAEFIK_SSL_PORT,
					PublishMode: "host",
					Protocol : "tcp",
				},
				{
					TargetPort: 80,
					PublishedPort: TRAEFIK_PORT,
					PublishMode: "host",
				},
				...(enableDashboard
					? [
							{
								TargetPort: 8080,
								PublishedPort: 8080,
								PublishMode: "host" as const,
							},
						]
					: []),
			],
		},
	};
	try {
		await pullImage(imageName);

		const service = docker.getService(containerName);
		const inspect = await service.inspect();

		const existingEnv = inspect.Spec.TaskTemplate.ContainerSpec.Env || [];
		const updatedEnv = !env ? existingEnv : env;

		const updatedSettings = {
			...settings,
			TaskTemplate: {
				...settings.TaskTemplate,
				ContainerSpec: {
					...(settings?.TaskTemplate as ContainerTaskSpec).ContainerSpec,
					Env: updatedEnv,
				},
			},
		};
		await service.update({
			version: Number.parseInt(inspect.Version.Index),
			...updatedSettings,
		});

		console.log("Traefik Started ✅");
	} catch (error) {
		await docker.createService(settings);
		console.log("Traefik Not Found: Starting ✅");
	}
};

export const createDefaultServerTraefikConfig = () => {
	const configFilePath = path.join(DYNAMIC_TRAEFIK_PATH, "dokploy.yml");

	if (existsSync(configFilePath)) {
		console.log("Default traefik config already exists");
		return;
	}

	const appName = "dokploy";
	const serviceURLDefault = `http://${appName}:${process.env.PORT || 3000}`;
	const config: FileConfig = {
		http: {
			routers: {
				[`${appName}-router-app`]: {
					rule: `Host(\`${appName}.docker.localhost\`) && PathPrefix(\`/\`)`,
					service: `${appName}-service-app`,
					entryPoints: ["web"],
				},
			},
			services: {
				[`${appName}-service-app`]: {
					loadBalancer: {
						servers: [{ url: serviceURLDefault }],
						passHostHeader: true,
					},
				},
			},
		},
	};

	const yamlStr = dump(config);
	mkdirSync(DYNAMIC_TRAEFIK_PATH, { recursive: true });
	writeFileSync(
		path.join(DYNAMIC_TRAEFIK_PATH, `${appName}.yml`),
		yamlStr,
		"utf8",
	);
};

export const createDefaultTraefikConfig = (enableHTTP3: boolean) => {
	const mainConfig = path.join(MAIN_TRAEFIK_PATH, "traefik.yml");
	const acmeJsonPath = path.join(DYNAMIC_TRAEFIK_PATH, "acme.json");

	if (existsSync(acmeJsonPath)) {
		chmodSync(acmeJsonPath, "600");
	}
	if (existsSync(mainConfig)) {
		console.log("Main config already exists");
		return;
	}
	const configObject: MainTraefikConfig = {
		providers: {
			...(process.env.NODE_ENV === "development"
				? {
						docker: {
							defaultRule:
								"Host(`{{ trimPrefix `/` .Name }}.docker.localhost`)",
						},
					}
				: {
						swarm: {
							exposedByDefault: false,
							watch: false,
						},
						docker: {
							exposedByDefault: false,
						},
					}),
			file: {
				directory: "/etc/dokploy/traefik/dynamic",
				watch: true,
			},
		},
		entryPoints: {
			web: {
				address: `:${TRAEFIK_PORT}`,
			},
			websecure: {
				address: `:${TRAEFIK_SSL_PORT}`,
				...(process.env.NODE_ENV === "production" && {

					http3: enableHTTP3 ? {
						advertisedPort: TRAEFIK_SSL_PORT,
					} : undefined,
					http: {
						tls: {
							certResolver: "letsencrypt",
						},
					},
				}),
			},
		},
		api: {
			insecure: true,
		},
		...(process.env.NODE_ENV === "production" && {
			certificatesResolvers: {
				letsencrypt: {
					acme: {
						email: "test@localhost.com",
						storage: "/etc/dokploy/traefik/dynamic/acme.json",
						httpChallenge: {
							entryPoint: "web",
						},
					},
				},
			},
		}),
	};

	const yamlStr = dump(configObject);
	mkdirSync(MAIN_TRAEFIK_PATH, { recursive: true });
	writeFileSync(mainConfig, yamlStr, "utf8");
};

export const createDefaultMiddlewares = () => {
	const middlewaresPath = path.join(DYNAMIC_TRAEFIK_PATH, "middlewares.yml");
	if (existsSync(middlewaresPath)) {
		console.log("Default middlewares already exists");
		return;
	}
	const defaultMiddlewares = {
		http: {
			middlewares: {
				"redirect-to-https": {
					redirectScheme: {
						scheme: "https",
						permanent: true,
					},
				},
			},
		},
	};
	const yamlStr = dump(defaultMiddlewares);
	mkdirSync(DYNAMIC_TRAEFIK_PATH, { recursive: true });
	writeFileSync(middlewaresPath, yamlStr, "utf8");
};
