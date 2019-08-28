const Core = require('@alicloud/pop-core'),
    os = require('os');

const db = {};

module.exports.handler = function (req, resp, context) {
    // Init
    const creds = context.credentials;
    const client = new Core({
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.accessKeySecret,
        endpoint: 'http://ecs.aliyuncs.com',
        apiVersion: '2014-05-26'
    });

    // Setting Params
    const region = req.queries.regionid || "eu-central-1";
    resp.setHeader("content-type", "text/csv");

    if (db[region] !== undefined) {
        resp.send(db[region]);
    }

    let payGoPrices = null;
    let subscriptionPrices = null;
    let availableInstanceTypes = null;

    // Sending Request
    client.request('DescribeAvailableResource', {
        "RegionId": region,
        "DestinationResource": "InstanceType",
        "IoOptimized": "optimized",
        "SecurityToken": creds.securityToken
    }).then((result) => {
        const instanceTypes = [];
        for (const resourcesAz of result.AvailableZones.AvailableZone) {
            for (const avres of resourcesAz.AvailableResources.AvailableResource) {
                for (const supres of avres.SupportedResources.SupportedResource) {
                    instanceTypes.push(supres.Value);
                }
            }
        }
        return [...new Set(instanceTypes)];
    }).then((instanceTypes) => {
        availableInstanceTypes = instanceTypes;

        const coll = buildParamsforPrice(availableInstanceTypes, true, region, creds.securityToken);
        const promises = [];
        client.endpoint = 'http://business.ap-southeast-1.aliyuncs.com';
        client.apiVersion = '2017-12-14';
        for (const params of coll) {
            const res = client.request('GetPayAsYouGoPrice', params, { method: 'POST' });
            promises.push(res);
        }

        return Promise.all(promises)
            .then((prices) => {
                let merged = [];
                for (const price of prices) {
                    merged = merged.concat(price.Data.ModuleDetails.ModuleDetail);
                }
                return merged;
            });
    }).then((res) => {
        payGoPrices = res;
        const coll = buildParamsforPrice(availableInstanceTypes, false, region, creds.securityToken);
        const promises = [];
        for (const params of coll) {
            const res = client.request('GetPayAsYouGoPrice', params, { method: 'POST' });
            promises.push(res);
        }

        return Promise.all(promises)
            .then((prices) => {
                let merged = [];
                for (const price of prices) {
                    merged = merged.concat(price.Data.ModuleDetails.ModuleDetail);
                }
                return merged;
            });
    }).then((res) => {
        subscriptionPrices = res;
        const csv = formatResultAsCsv(availableInstanceTypes, payGoPrices, subscriptionPrices, region)
        db[region] = csv;
        resp.send(csv);
    }).catch((ex) => {
        console.log(ex)
        resp.setStatusCode(500);
        resp.send("There was a server side error: " + JSON.stringify(ex));
    });
}

function buildParamsforPrice(instanceTypes, payGo, region, securityToken) {
    const coll = [];
    let params = {};
    for (const [i, v] of instanceTypes.entries()) {
        if ((i + 1) % 50 !== 0) {
            params[`ModuleList.${(i % 50) + 1}.ModuleCode`] = 'InstanceType';
            params[`ModuleList.${(i % 50) + 1}.Config`] = `InstanceType:${v},IoOptimized:IoOptimized,ImageOs:linux`
            params[`ModuleList.${(i % 50) + 1}.PriceType`] = (payGo == true) ? 'Hour' : 'Month';
        } else {
            params[`ModuleList.${(i % 50) + 1}.ModuleCode`] = 'InstanceType';
            params[`ModuleList.${(i % 50) + 1}.Config`] = `InstanceType:${v},IoOptimized:IoOptimized,ImageOs:linux`
            params[`ModuleList.${(i % 50) + 1}.PriceType`] = (payGo == true) ? 'Hour' : 'Month';

            params.Region = region;
            params.RegionId = 'ap-southeast-1';
            params.ProductCode = 'ecs';
            params.SubscriptionType = (payGo == true) ? 'PayAsYouGo' : 'Subscription';
            params.SecurityToken = securityToken
            coll.push(params);
            params = {};
        }
    }
    // Adding the rest
    if (instanceTypes.length >= 50 || instanceTypes.length < 50) {
        params.Region = region;
        params.RegionId = 'ap-southeast-1';
        params.ProductCode = 'ecs';
        params.SubscriptionType = (payGo == true) ? 'PayAsYouGo' : 'Subscription';
        params.SecurityToken = securityToken
        coll.push(params);
    }

    return coll;
}


function formatResultAsCsv(instanceTypes, payGoPrices, subscriptionPrices, region) {
    let output = 'InstanceType, PAYGO (Hour), Subscription (Monthly), RegionId' + os.EOL;
    for (const [i, v] of instanceTypes.entries()) {
        const payGoPrice = (payGoPrices[i] !== undefined) ? payGoPrices[i].OriginalCost.toFixed(3) : "N/A";
        const subscriptionPrice = (subscriptionPrices[i] !== undefined) ? subscriptionPrices[i].OriginalCost.toFixed(2) : "N/A";
        output += `${v}, ${payGoPrice}, ${subscriptionPrice}, ${region}` + os.EOL;
    }

    return output;
}