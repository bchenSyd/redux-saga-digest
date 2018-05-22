import { is, check, object, createSetContextWarning } from './utils'
import { stdChannel } from './channel'
import { identity } from './utils'
import { runSaga } from './runSaga'

export default function sagaMiddlewareFactory({ context = {}, ...options } = {}) {
  const { sagaMonitor, logger, onError, effectMiddlewares } = options

  if (process.env.NODE_ENV === 'development') {
    if (is.notUndef(logger)) {
      check(logger, is.func, 'options.logger passed to the Saga middleware is not a function!')
    }

    if (is.notUndef(onError)) {
      check(onError, is.func, 'options.onError passed to the Saga middleware is not a function!')
    }

    if (is.notUndef(options.emitter)) {
      check(options.emitter, is.func, 'options.emitter passed to the Saga middleware is not a function!')
    }
  }

  function sagaMiddleware({ getState, dispatch }) {
    const channel = stdChannel()
    channel.put = (options.emitter || identity)(channel.put)

    // runSaga is the bootstrap program; core OS; grub2;
    sagaMiddleware.run = runSaga.bind(null, {
      context,
      channel, // stdChannel
      dispatch,
      getState,
      sagaMonitor,
      logger,
      onError,
      effectMiddlewares,
    })

    return next => action => {
      if (sagaMonitor && sagaMonitor.actionDispatched) {
        sagaMonitor.actionDispatched(action)
      }
      const result = next(action) // hit reducers; Contrary to redux-thunk, redux-saga won't hijack redux flow;
      channel.put(action /*action is the input object*/); // feed stdChannell using redux actions
      return result
    }
  }

  sagaMiddleware.run = () => {
    throw new Error('Before running a Saga, you must mount the Saga middleware on the Store using applyMiddleware')
  }

  sagaMiddleware.setContext = props => {
    if (process.env.NODE_ENV === 'development') {
      check(props, is.object, createSetContextWarning('sagaMiddleware', props))
    }

    object.assign(context, props)
  }

  return sagaMiddleware
}
