/**
 * Lambda Function to Determine the Total # of Permutations
 * for a given number of total prescribed pills.
 *
 * For all requests, this service first checks a DynamoDB cache table
 * to see if the calculations has already been performed, and returns it. 
 *
 * If the value is not found in cache, this service will on-demand compute
 * the value for all number of pills inclusively between 0 - 43. 
 *
 * For total pills > 43, due to an API GW hard timeout of 30 seconds, 
 * this service will defer the request, and respond back with information
 * on the deferred task and details on how to access the response when available.
 *
 * REQUIRED ENVIRONMENT VARIABLES
 *  cacheUrl   - The Cache URL containing previously computed permutations.
 *  deferUrl   - The URL to POST deferred requests to. 
 *
 * @author Rob Mullins <rob.mullins.official@gmail.com>
 */

// Import Dependencies:
const Dynamo  = require('dynamodb');
const Request = require('request');
const UUID    = require('uuid/v1');

// Set Defaults:
const minPillsPerDay = 1;
const maxPillsPerDay = 2;

/**
 * Lambda Entry Point
 * Calculates the total # of permutations for the client specified total number of pills. 
 *
 * @param {object} event            - Data containing the client/caller information, such as querystrings, IP address, etc.
 * @param {object} context          - Object containing runtime information for this Lambda function.
 * @param {LambdaCallback} callback - The callback that handles the Lambda completion.
 *
 * @callback LambdaCallback
 * @param {Error}         error     - Optional error object to indicate Lambda failure. 
 * @param {object|string} success   - Optional JSON.stringify compatible object or string to indicate Lambda success.
 */
exports.handler = async function(event, context, callback) {
  // Ensure Required Environment Variables Set:
  if (!process.env.cacheUrl) return callback('Error: The `cacheUrl` environment variable was not set', prepareResponse(500, {success: false, message: 'Internal Error!'}));
  if (!process.env.deferUrl) return callback('Error: The `deferUrl` environment variable was not set', prepareResponse(500, {success: false, message: 'Internal Error!'}));

  // Validate `pills` QueryString Param:
  if (!event.queryStringParameters.pills)                    return callback(null, prepareResponse(400, {success: false, message: 'You must provide the `pills` querystring parameter!'}));
  if (typeof event.queryStringParameters.pills !== 'number') return callback(null, prepareResponse(400, {success: false, message: 'Pills must be a valid number!'}));
  if (event.queryStringParameters.pills < 1 || event.queryStringParameters.pills > 47) return callback(null, prepareResponse(400, {success: false, message: 'Pills must be a number between 1 and !'}));

  // Global to hold # of permutations:
  let numberOfPermutations = 0; 
  
  //** Check if value exists in cache **//
  try {
    numberOfPermutations = await getFromCache(event.queryStringParameters.pills);
    if (numberOfPermutations) return callback(null, prepareResponse(200, {success: true, status: 'complete', permutations: numberOfPermutations})); // Cache hit, send response.
  } catch (e) {
    console.log(e); // Cache check failed, program proceeds below...
  }

  //** Cache Miss :: Calculate Permutations **//
  if (event.queryStringParameters.pills <= 43) {
    getNumberOfPermutations(event.queryStringParameters.pills, 0); 
    callback(null, prepareResponse(200, {success: true, status: 'complete', permutations: numberOfPermutations})); // Send the response now, but proceed with saving to cache below..
    try {
      const saved = await saveToCache(event.queryStringParameters.pills, numberOfPermutations);
      if (saved) return true; // End Lambda execution now..
    } catch (e) {
      console.log(e); 
      return true; // End Lambda execution now..
    }
  } else {
    // Pills too large, defer the task:
    try {
      const taskId = await deferTask(event.queryStringParameters.pills);
      if (taskId) return callback(null, prepareResponse(202, {
        success : true, 
        status  : 'deferred',
        task    : {
          url: process.env.deferUrl +'/' +taskId,
          id : taskId
        }
      }));
    } catch (e) {
      return callback(e, prepareResponse(500, {success: false, error: 'Internal Error!'})); // Defer failed, error is logged, return generic response to client.
    }
  }

  /**
   * Recursively calculates the total number of permutations for a given `numberOfPills` value.    
   *
   * @param    {int} numberOfPills - The number of pills to calculate permutations for.
   * @param    {int} sum           - The recursively determined sum, incremented until it equals the `numberOfPills`.
   * @return   VOID                - Increments a global value `numberOfPermutations`.
   */
  function getNumberOfPermutations(numberOfPills, sum) {
    if (sum > numberOfPills)   return false;
    if (sum === numberOfPills) return numberOfPermutations++;
    for (let i = minPillsPerDay; i <= maxPillsPerDay; i++) { 
      getNumberOfPermutations(numberOfPills, sum+i);
    }
  }

  /**
   * Checks cache to see if permutations has already been determined for given # of pills
   *
   * @param    {int} numberOfPills    - The total number of pills, also the cache key.
   * @throws   {Error}                - If request to cache fails. 
   * @return   {int||null}            - The number of permutations if found in cache, otherwise null.
   */
  async function getFromCache(numberOfPills) {
    Request({
      url     : process.env.cacheUrl,
      method  : 'GET',
      qs      : {pills: numberOfPills},
      headers : {'Content-Type': 'application/json'}
    }, (err, res, body) => {
      if (err) throw new Error('Error: Internal Error Making GET Request to Cache Service - ' +err);
      if (res.statusCode !== 200) throw new Error('Error: GET Request to Cache Service failed - ' +res);
      try {
        body = JSON.parse(body);
        if (body.permutations) return body.permutations;
        else return 0;
      } catch (e) {
        throw new Error('Error: Error parsing response from cache - ' +e);
      }
    });
  }

  /**
   * Saves the number of permutations for the given number of pills in the cache.
   *
   * @param    {int} numberOfPills        - The total number of pills, also the cache key
   * @param    {int} numberOfPermutations - The total number of permutations for the total pills, also the cache value.
   * @throws   {Error}                    - If request to cache fails. 
   * @return   {bool}                     - True on successful save. 
   */
  async function saveToCache(numberOfPills, numberOfPermutations) {
    Request({
      url     : process.env.cacheUrl,
      method  : 'POST',
      body    : {pills: numberOfPills, permutations: numberOfPermutations},
      headers : {'Content-Type': 'application/json'}
    }, (err, res, body) => {
      if (err) throw new Error('Error: Internal Error Making POST Request to Cache Service - ' +err);
      if (res.statusCode !== 200) throw new Error('Error: POST Request to Cache Service failed - ' +res);
      return true;
    });
  }

  /**
   * Defers the calculation to the deferred task service, via POST request.
   *
   * @param    {int} numberOfPills - The total number of pills to calculate permutations for. 
   * @throws   {Error}             - If request to deferTask service fails. 
   * @return   {string}            - The unique ID for this deferred task. 
   */
  async function deferTask(numberOfPills) {
    const id = UUID();
    Request({
      url     : process.env.deferUrl,
      method  : 'POST',
      body    : {id: id, pills: numberOfPills},
      headers : {'Content-Type': 'application/json'}
    }, (err, res, body) => {
      if (err) throw new Error('Error: Internal Error Making POST Request to Defer Service - ' +err);
      if (res.statusCode !== 200) throw new Error('Error: POST Request to Defer Service Failed - ' +res);
      return id; // Return deferred job/task ID
    });
  }

  /**
   * Prepares & Formats the Lamdba HTTP Response
   * @param  {number} statusCode - The HTTP response code.
   * @param  {obj}    body       - Response object.
   * @return {object}            - Lambda formatted Response.
   */
  function prepareResponse(statusCode, body) {
    return {
      statusCode      : statusCode,
      body            : JSON.stringify(body), 
      headers         : {"Access-Control-Allow-Origin": "*"},
      isBase64Encoded : false
    };
  }
};
