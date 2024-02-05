import * as pulumi from '@pulumi/pulumi'
import * as resources from '@pulumi/azure-native/resources'
import * as containerregistry from '@pulumi/azure-native/containerregistry'
import * as docker from '@pulumi/docker'
import * as containerinstance from '@pulumi/azure-native/containerinstance'
import * as cache from '@pulumi/azure-native/cache'

// Import the configuration settings for the current stack.
const config = new pulumi.Config();
const appPath = config.get("appPath") || "../";
const prefixName = config.get("prefixName") || "cst8918a03student";
const imageName = prefixName;
const imageTag = config.get("imageTag") || "latest";
// Azure container instances (ACI) service does not yet support port mapping
// so, the containerPort and publicPort must be the same
const containerPort = config.getNumber("containerPort") || 80;
const publicPort = config.getNumber("publicPort") || 80;
const cpu = config.getNumber("cpu") || 1;
const memory = config.getNumber("memory") || 2;

// Create a resource group.
const resourceGroup = new resources.ResourceGroup(${prefixName}-rg);

// Create the container registry.
const registry = new containerregistry.Registry(${prefixName}ACR, {
  resourceGroupName: resourceGroup.name,
  adminUserEnabled: true,
  sku: {
    name: containerregistry.SkuName.Basic,
  },
});

// Get the authentication credentials for the container registry.
const registryCredentials = containerregistry
  .listRegistryCredentialsOutput({
    resourceGroupName: resourceGroup.name,
    registryName: registry.name,
  })
  .apply((creds) => {
    return {
      username: creds.username!,
      password: creds.passwords![0].value!,
    };
  });

const image = new docker.Image(${prefixName}-image, {
  imageName: pulumi.interpolate`${registry.loginServer}/${imageName}:${imageTag}`,
  build: {
    context: appPath,
    platform: "linux/amd64",
  },
  registry: {
    server: registry.loginServer,
    username: registryCredentials.username,
    password: registryCredentials.password,
  },
});

const redis = new cache.Redis(${prefixName}-redis, {
  name: ${prefixName}-weather-cache,
  location: 'westus3',
  resourceGroupName: resourceGroup.name,
  enableNonSslPort: true,
  redisVersion: 'Latest',
  minimumTlsVersion: '1.2',
  redisConfiguration: {
    maxmemoryPolicy: 'allkeys-lru'
  },
  sku: {
    name: 'Basic',
    family: 'C',
    capacity: 0
  }
})

// Extract the auth creds from the deployed Redis service
const redisAccessKey = cache
  .listRedisKeysOutput({ name: redis.name, resourceGroupName: resourceGroup.name })
  .apply(keys => keys.primaryKey)


  const redisConnectionString = pulumi.interpolate`rediss://:${redisAccessKey}@${redis.hostName}:${redis.sslPort}`

const containerGroup = new containerinstance.ContainerGroup(
  ${prefixName}-container-group,
  {
    resourceGroupName: resourceGroup.name,
    osType: "linux",
    restartPolicy: "always",
    imageRegistryCredentials: [
      {
        server: registry.loginServer,
        username: registryCredentials.username,
        password: registryCredentials.password,
      },
    ],
    containers: [
      {
        name: imageName,
        image: image.imageName,
        ports: [
          {
            port: containerPort,
            protocol: "tcp",
          },
        ],
        environmentVariables: [
          {
            name: "PORT",
            value: containerPort.toString(),
          },
          {
            name: "WEATHER_API_KEY",
            value: config.requireSecret("weatherApiKey"),
          },
          {
            name: 'REDIS_URL',
            value: redisConnectionString
          },
        ],
        resources: {
          requests: {
            cpu: cpu,
            memoryInGB: memory,
          },
        },
      },
    ],
    ipAddress: {
      type: containerinstance.ContainerGroupIpAddressType.Public,
      dnsNameLabel: ${imageName},
      ports: [
        {
          port: publicPort,
          protocol: "tcp",
        },
      ],
    },
  }
);

export const hostname = containerGroup.ipAddress.apply((addr) => addr!.fqdn!);
export const ip = containerGroup.ipAddress.apply((addr) => addr!.ip!);
export const url = containerGroup.ipAddress.apply(
  (addr) => http://${addr!.fqdn!}:${containerPort}
);