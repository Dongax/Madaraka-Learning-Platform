// Express 4 does not automatically catch rejected promises from an async
// route handler — an unhandled rejection there would otherwise hang the
// request (or crash the process). Wrapping every handler with this turns
// any thrown/rejected error into next(err), which Express's default error
// handler converts into a 500 response.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
