import {IImpactModelInterface} from "../interfaces";
import Spline from 'typescript-cubic-spline';
import * as aws_instances from './aws-instances.json';
import * as gcp_instances from './gcp-instances.json';
import * as gcp_use from './gcp-use.json';
import * as aws_use from './aws-use.json';
import * as azure_use from './azure-use.json';
import * as azure_instances from './azure-instances.json';
import * as gcp_embodied from './gcp-embodied.json';
import * as aws_embodied from './aws-embodied.json';
import * as azure_embodied from './azure-embodied.json';

interface IConsumption {
    idle?: number;
    tenPercent?: number;
    fiftyPercent?: number;
    hundredPercent?: number;
    minWatts?: number;
    maxWatts?: number;
}

interface IComputeInstance {
    consumption: IConsumption;
    embodiedEmission?: number;
    name: string;
    vCPUs?: number;
    maxVCPUs?: number;
}

export class CloudCarbonFootprint implements IImpactModelInterface {
    authParams: object | undefined;
    // name of the data source
    name: string | undefined;
    // compute instances grouped by the provider with usage data
    computeInstances: { [key: string]: { [key: string]: IComputeInstance } } = {};
    gcpList: { [key: string]: any } = {};
    azureList: { [key: string]: any } = {};
    awsList: { [key: string]: any } = {};
    provider: string = '';
    instanceType: string = '';
    expectedLifespan = 4;

    constructor() {
        this.standardizeInstanceMetrics();
    }

    authenticate(authParams: object): void {
        this.authParams = authParams;
    }

    async configure(name: string, staticParams: object | undefined = undefined): Promise<IImpactModelInterface> {
        console.log(name, staticParams)
        if (staticParams === undefined) {
            throw new Error('Required Parameters not provided');
        }
        if ('provider' in staticParams) {
            const provider = staticParams?.provider as string;
            if (['aws', 'gcp', 'azure'].includes(provider)) {
                this.provider = provider;
            } else {
                throw new Error('Provider not supported');
            }
        }
        if ('instance_type' in staticParams) {
            const instanceType = staticParams?.instance_type as string;
            if (instanceType in this.computeInstances[this.provider]) {
                this.instanceType = instanceType;
            } else {
                throw new Error('Instance Type not supported');
            }
        }
        if ('expected_lifespan' in staticParams) {
            this.expectedLifespan = staticParams?.expected_lifespan as number;
        }
        return this;
    }

    async calculate(observations: object | object[] | undefined): Promise<object> {
        console.log(observations);
        if (observations === undefined) {
            throw new Error('Required Parameters not provided');
        }
        let eTotal = 0.0;
        let mTotal = 0.0;
        // let mTotal = this.embodiedEmissions();
        if (Array.isArray(observations)) {
            observations.forEach((observation: { [key: string]: any }) => {
                eTotal += this.calculateEnergy(observation);
                mTotal += this.embodiedEmissions(observation);
            });
        }
        console.log(mTotal, eTotal)
        return {
            "e": eTotal,
            "m": mTotal,
        };
    }

    calculateEnergy(observation: { [key: string]: any; }) {
        if (!('duration' in observation) || !('cpu' in observation) || !('datetime' in observation)) {
            throw new Error('Required Parameters duration,cpu,datetime not provided for observation');
        }
        //    duration is in seconds
        const duration = observation['duration'];
        //    convert cpu usage to percentage
        const cpu = observation['cpu'] * 100.0;
        //  get the wattage for the instance type
        let wattage = 0;
        if (this.provider === 'aws') {
            const x = [0, 10, 50, 100];
            const y: number[] = [
                this.computeInstances['aws'][this.instanceType].consumption.idle ?? 0,
                this.computeInstances['aws'][this.instanceType].consumption.tenPercent ?? 0,
                this.computeInstances['aws'][this.instanceType].consumption.fiftyPercent ?? 0,
                this.computeInstances['aws'][this.instanceType].consumption.hundredPercent ?? 0
            ];
            const spline = new Spline(x, y);
            wattage = spline.at(cpu);
        } else if (this.provider === 'gcp' || this.provider === 'azure') {
            const idle = this.computeInstances[this.provider][this.instanceType].consumption.minWatts ?? 0;
            const max = this.computeInstances[this.provider][this.instanceType].consumption.maxWatts ?? 0;
            const x = [0, 100];
            const y: number[] = [idle, max];
            const spline = new Spline(x, y);
            wattage = spline.at(cpu);
        }
        //  duration is in seconds
        //  wattage is in watts
        //  eg: 30W x 300s = 9000 J
        //  1 Wh = 3600 J
        //  9000 J / 3600 = 2.5 Wh
        //  J / 3600 = Wh
        //  2.5 Wh / 1000 = 0.0025 kWh
        //  Wh / 1000 = kWh
        // (wattage * duration) / (seconds in an hour) / 1000 = kWh
        return ((wattage * duration) / 3600) / 1000;
    }


    modelIdentifier(): string {
        return "ccf.cloud.sci";
    }

    standardizeInstanceMetrics() {
        this.computeInstances['aws'] = {};
        this.computeInstances['gcp'] = {};
        this.computeInstances['azure'] = {};
        let gcpMin = 0.0;
        let gcpMax = 0.0;
        let gcpCount = 0;
        // standardize gcp emissions
        gcp_use.forEach((instance: { [key: string]: any }) => {
            this.gcpList[instance['Architecture']] = instance;
            gcpMin += parseFloat(instance['Min Watts']);
            gcpMax += parseFloat(instance['Max Watts']);
            gcpCount += 1;
        });
        const gcpAvgMin = gcpMin / gcpCount;
        const gcpAvgMax = gcpMax / gcpCount;
        this.gcpList['Average'] = {
            'Min Watts': gcpAvgMin,
            'Max Watts': gcpAvgMax,
            'Architecture': 'Average',
        };
        let azureMin = 0.0;
        let azureMax = 0.0;
        let azureCount = 0;
        azure_use.forEach((instance: { [key: string]: any }) => {
            this.azureList[instance['Architecture']] = instance;
            azureMin += parseFloat(instance['Min Watts']);
            azureMax += parseFloat(instance['Max Watts']);
            azureCount += 1;
        });
        const azureAvgMin = azureMin / azureCount;
        const azureAvgMax = azureMax / azureCount;
        this.azureList['Average'] = {
            'Min Watts': azureAvgMin,
            'Max Watts': azureAvgMax,
            'Architecture': 'Average',
        }
        aws_use.forEach((instance: { [key: string]: any }) => {
            this.awsList[instance['Architecture']] = instance;
        });
        aws_instances.forEach((instance: { [key: string]: any }) => {
            this.computeInstances['aws'][instance['Instance type']] = {
                'consumption': {
                    'idle': parseFloat(instance['Instance @ Idle'].replace(',', '.')),
                    'tenPercent': parseFloat(instance['Instance @ 10%'].replace(',', '.')),
                    'fiftyPercent': parseFloat(instance['Instance @ 50%'].replace(',', '.')),
                    'hundredPercent': parseFloat(instance['Instance @ 100%'].replace(',', '.')),
                },
                'vCPUs': parseInt(instance['Instance vCPU'], 10),
                'maxvCPUs': parseInt(instance['Platform Total Number of vCPU'], 10),
                'name': instance['Instance type'],
            } as IComputeInstance;
        });
        gcp_instances.forEach((instance: { [key: string]: any }) => {
            const cpus = parseInt(instance['Instance vCPUs'], 10);
            let architecture = instance['Microarchitecture'];
            if (!(architecture in this.azureList)) {
                architecture = 'Average';
            }
            this.computeInstances['gcp'][instance['Machine type']] = {
                'name': instance['Machine type'],
                'vCPUs': cpus,
                'consumption': {
                    'minWatts': this.gcpList[architecture]['Min Watts'] * cpus,
                    'maxWatts': this.gcpList[architecture]['Max Watts'] * cpus,
                },
                'maxvCPUs': parseInt(instance['Platform vCPUs (highest vCPU possible)'], 10)
            } as IComputeInstance;
        });
        azure_instances.forEach((instance: { [key: string]: any }) => {
            const cpus = parseInt(instance['Instance vCPUs'], 10);
            let architecture = instance['Microarchitecture'];
            if (!(architecture in this.azureList)) {
                architecture = 'Average';
            }
            this.computeInstances['azure'][instance['Virtual Machine']] = {
                consumption: {
                    'minWatts': this.azureList[architecture]['Min Watts'] * cpus,
                    'maxWatts': this.azureList[architecture]['Max Watts'] * cpus,
                },
                'name': instance['Virtual Machine'],
                'vCPUs': instance['Instance vCPUs'],
                'maxvCPUs': parseInt(instance['Platform vCPUs (highest vCPU possible)'], 10)
            } as IComputeInstance;
        });
        aws_embodied.forEach((instance: { [key: string]: any }) => {
            this.computeInstances['aws'][instance['type']].embodiedEmission = instance['total'];
        });
        gcp_embodied.forEach((instance: { [key: string]: any }) => {
            this.computeInstances['gcp'][instance['type']].embodiedEmission = instance['total'];
        });
        azure_embodied.forEach((instance: { [key: string]: any }) => {
            this.computeInstances['azure'][instance['type']].embodiedEmission = instance['total'];
        });
    }

    embodiedEmissions(observation: { [key: string]: any; }): number {
        // duration
        const duration_in_hours = observation['duration'] / 3600;
        // M = TE * (TR/EL) * (RR/TR)
        // Where:
        // TE = Total Embodied Emissions, the sum of Life Cycle Assessment(LCA) emissions for all hardware components
        // TR = Time Reserved, the length of time the hardware is reserved for use by the software
        // EL = Expected Lifespan, the anticipated time that the equipment will be installed
        // RR = Resources Reserved, the number of resources reserved for use by the software.
        // TR = Total Resources, the total number of resources available.
        const TotalEmissions = this.computeInstances[this.provider][this.instanceType].embodiedEmission ?? 0;
        const TimeReserved = duration_in_hours;
        const ExpectedLifespan = 8760 * this.expectedLifespan;
        const ReservedResources = this.computeInstances[this.provider][this.instanceType].vCPUs ?? 1.0;
        const TotalResources = this.computeInstances[this.provider][this.instanceType].maxVCPUs ?? 1.0;
        return TotalEmissions * (TimeReserved / ExpectedLifespan) * (ReservedResources / TotalResources);
    }
}
