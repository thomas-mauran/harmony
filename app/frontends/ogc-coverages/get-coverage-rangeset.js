const { SpatialReference } = require('gdal-next');
const DataOperation = require('../../models/data-operation');
const { keysToLowerCase } = require('../../util/object');
const { RequestValidationError } = require('../../util/errors');

/**
 * Express middleware that responds to OGC API - Coverages coverage
 * rangeset requests.  Responds with the actual coverage data.
 *
 * @param {http.IncomingMessage} req The request sent by the client
 * @param {http.ServerResponse} res The response to send to the client
 * @param {function} next The next express handler
 * @returns {void}
 * @throws {RequestValidationError} Thrown if the request has validation problems and
 *   cannot be performed
 */
function getCoverageRangeset(req, res, next) {
  const query = keysToLowerCase(req.query);
  const operation = new DataOperation();
  operation.outputFormat = 'image/tiff'; // content negotiation to be added in HARMONY-173

  if (query.granuleid) {
    operation.granuleIds = query.granuleid.split(',');
  }
  if (query.outputcrs) {
    try {
      operation.crs = SpatialReference.fromUserInput(query.outputcrs).toProj4();
    } catch (e) {
      throw new RequestValidationError('query parameter "outputCrs" could not be parsed.  Try an EPSG code or Proj4 string.');
    }
  }

  // Note that "collectionId" from the Open API spec is an OGC API Collection, which is
  // what we would call a variable (or sometimes a named group of variables).  In the
  // OpenAPI spec doc, a "collection" refers to a UMM-Var variable, and a "CMR collection" refers
  // to a UMM-C collection.  In the code, wherever possible, collections are UMM-C collections
  // and variables are UMM-Var variables.  The following line is the confusing part where we
  // translate between the two nomenclatures.
  const variableIds = req.params.collectionId.split(',');

  if (variableIds.indexOf('all') !== -1) {
    // If the variable ID is "all" do not subset by variable
    if (variableIds.length !== 1) {
      throw new RequestValidationError('"all" cannot be specified alongside other variables');
    }
    for (const collection of req.collections) {
      operation.addSource(collection.id);
    }
  } else {
    // Figure out which variables belong to which collections and whether any are missing.
    // Note that a single variable name may appear in multiple collections
    let missingVariables = variableIds;
    for (const collection of req.collections) {
      const variables = [];
      for (const variableId of variableIds) {
        const variable = collection.variables.find((v) => v.name === variableId);
        if (variable) {
          missingVariables = missingVariables.filter((v) => v !== variableId);
          variables.push({ id: variable.concept_id, name: variable.name });
        }
      }
      operation.addSource(collection.id, variables);
    }
    if (missingVariables.length > 0) {
      throw new RequestValidationError(`Coverages were not found for the provided CMR collection: ${missingVariables.join(', ')}`);
    }
  }
  req.operation = operation;
  next();
}

module.exports = getCoverageRangeset;
