import {
  CANCEL,
  CHANNEL_END as CHANNEL_END_SYMBOL,
  TASK,
  TASK_CANCEL as TASK_CANCEL_SYMBOL,
  SELF_CANCELLATION,
} from './symbols'
import {
  noop,
  is,
  log as _log,
  check,
  deferred,
  uid as nextEffectId,
  array,
  remove,
  object,
  makeIterator,
  createSetContextWarning,
} from './utils'

import { getLocation, addSagaStack, sagaStackToString } from './error-utils'

import { asap, suspend, flush } from './scheduler'
import { asEffect } from './io'
import { channel, isEnd } from './channel'
import matcher from './matcher'

export function getMetaInfo(fn) {
  return {
    name: fn.name || 'anonymous',
    location: getLocation(fn),
  }
}

function getIteratorMetaInfo(iterator, fn) {
  if (iterator.isSagaIterator) {
    return { name: iterator.meta.name }
  }
  return getMetaInfo(fn)
}

// TODO: check if this hacky toString stuff is needed
// also check again whats the difference between CHANNEL_END and CHANNEL_END_TYPE
// maybe this could become MAYBE_END
// I guess this gets exported so takeMaybe result can be checked
export const CHANNEL_END = {
  toString() {
    return CHANNEL_END_SYMBOL
  },
}
export const TASK_CANCEL = {
  toString() {
    return TASK_CANCEL_SYMBOL
  },
}

/**
  Used to track a parent task and its forks
  In the new fork model, forked tasks are attached by default to their parent
  We model this using the concept of Parent task && main Task
  main task is the main flow of the current Generator, the parent tasks is the
  aggregation of the main tasks + all its forked tasks.
  Thus the whole model represents an execution tree with multiple branches (vs the
  linear execution tree in sequential (non parallel) programming)

  A parent tasks has the following semantics
  - It completes if all its forks either complete or all cancelled
  - If it's cancelled, all forks are cancelled as well
  - It aborts if any uncaught error bubbles up from forks
  - If it completes, the return value is the one returned by the main task
**/
function forkQueue(mainTask, onAbort, cb) {
  let tasks = [], // how is this queue different from scheduler.queue ? 
    result,
    completed = false
  addTask(mainTask)
  const getTasks = () => tasks
  const getTaskNames = () => tasks.map(t => t.meta.name)

  function abort(err) {
    onAbort()
    cancelAll()
    cb(err, true)
  }

  function addTask(task) {
    tasks.push(task) // push to the end of task queue;  flush() will take the first from the task queue;
    task.cont = (res, isErr) => {
      if (completed) {
        return
      }

      remove(tasks, task)
      task.cont = noop
      if (isErr) {
        abort(res)
      } else {
        if (task === mainTask) {
          result = res
        }
        if (!tasks.length) {
          completed = true
          cb(result)
        }
      }
    }
    // task.cont.cancel = task.cancel
  }

  function cancelAll() {
    if (completed) {
      return
    }
    completed = true
    tasks.forEach(t => {
      t.cont = noop
      t.cancel()
    })
    tasks = []
  }

  return {
    addTask,
    cancelAll,
    abort,
    getTasks,
    getTaskNames,
  }
}

function createTaskIterator({ context, fn, args }) {
  if (is.iterator(fn) /* you can fork another generator, which is the most case*/) {
    return fn
  }

  // catch synchronous failures; see #152 and #441
  let result, error
  try {
    // or you fork normal function
    result = fn.apply(context, args)
  } catch (err) {
    error = err
  }

  // i.e. yield(function* another_generator(){ yield something} )
  if (is.iterator(result)) {
    return result
  }

  // do not bubble up synchronous failures for detached forks
  // instead create a failed task. See #152 and #441
  return error
    ? makeIterator(() => {
      throw error
    })
    : makeIterator(
      (function () {
        let pc
        //********************************************************* */
        const eff = { done: false, value: result }
        //********************************************************* */
        const ret = value => ({ done: true, value })
        return arg => {
          if (!pc) {
            pc = true
            return eff // fake a yield result
          } else {
            return ret(arg)
          }
        }
      })(),
    )
}

export default function proc(
  iterator, // Effect / Promise / Iterator --> Iterator
  stdChannel,
  dispatch = noop,
  getState = noop,
  parentContext = {},
  options = {},
  parentEffectId = 0,
  meta,
  cont/*continue*/, // callback, the rest of workflow;
) {
  const { sagaMonitor, logger, onError, middleware } = options
  const log = logger || _log

  const logError = err => {
    log('error', err)
    if (err && err.sagaStack) {
      log('error', err.sagaStack)
    }
  }

  const taskContext = Object.create(parentContext)

  let crashedEffect = null
  const cancelledDueToErrorTasks = []
  /**
    Tracks the current effect cancellation
    Each time the generator progresses. calling runEffect will set a new value
    on it. It allows propagating cancellation to child effects
  **/
  next.cancel = noop

  /**
    Creates a new task descriptor for this generator, We'll also create a main task
    to track the main flow (besides other forked tasks)
  **/
  const task_descriptor = newTask(parentEffectId, meta, iterator, cont/*callback is here; can only be executed after taskQueue is cleared; blocking operation*/)
  const mainTask = { meta, cancel: cancelMain, isRunning: true } // make sure taskQueue is not empty

  //build up a task queue for the current process
  const taskQueue = forkQueue(
    mainTask,
    function onAbort() {
      cancelledDueToErrorTasks.push(...taskQueue.getTaskNames())
    },
    end,
  )

  /**
    cancellation of the main task. We'll simply resume the Generator with a Cancel
  **/
  function cancelMain() {
    if (mainTask.isRunning && !mainTask.isCancelled) {
      mainTask.isCancelled = true
      next(TASK_CANCEL)
    }
  }

  /**
    This may be called by a parent generator to trigger/propagate cancellation
    cancel all pending tasks (including the main task), then end the current task.

    Cancellation propagates down to the whole execution tree holded by this Parent task
    It's also propagated to all joiners of this task and their execution tree/joiners

    Cancellation is noop for terminated/Cancelled tasks tasks
  **/
  function cancel() {
    /**
      We need to check both Running and Cancelled status
      Tasks can be Cancelled but still Running
    **/
    if (iterator._isRunning && !iterator._isCancelled) {
      iterator._isCancelled = true
      taskQueue.cancelAll()
      /**
        Ending with a Never result will propagate the Cancellation to all joiners
      **/
      end(TASK_CANCEL)
    }
  }
  /**
    attaches cancellation logic to this task's continuation
    this will permit cancellation to propagate down the call chain
  **/
  cont && (cont.cancel = cancel)

  // tracks the running status
  iterator._isRunning = true

  // kicks up the generator ==> this could be the root saga (for root task), or a forked saga generator
  //################################################################################################################

  next() // dirver; genreator driver; main loop ; mainloop; bochen; driver main loop;

  //################################################################################################################


  // then return the task descriptor to the caller
  return task_descriptor;

  /**
    This is the generator driver
    It's a recursive async/continuation function which calls itself
    until the generator terminates or throws
  **/
  function next(arg, isErr) {
    // Preventive measure. If we end up here, then there is really something wrong
    if (!mainTask.isRunning) {
      throw new Error('Trying to resume an already finished generator')
    }

    try {
      let result
      if (isErr) {
        result = iterator.throw(arg)
      } else if (arg === TASK_CANCEL) {
        /**
          getting TASK_CANCEL automatically cancels the main task
          We can get this value here

          - By cancelling the parent task manually
          - By joining a Cancelled task
        **/
        mainTask.isCancelled = true
        /**
          Cancels the current effect; this will propagate the cancellation down to any called tasks
        **/
        next.cancel()
        /**
          If this Generator has a `return` method then invokes it
          This will jump to the finally block
        **/
        result = is.func(iterator.return) ? iterator.return(TASK_CANCEL) : { done: true, value: TASK_CANCEL }
      } else if (arg === CHANNEL_END) {
        // We get CHANNEL_END by taking from a channel that ended using `take` (and not `takem` used to trap End of channels)
        result = is.func(iterator.return) ? iterator.return() : { done: true }
      } else {


        result = iterator.next(arg) // this is NOT  blocking itself; becuase iterator.next immediately returns a promise;


      }

      // In JavaScript an iterator is an object that provides a next() method which returns the next item in the sequence. 
      // This method returns an object with two properties: done and value.
      // yield { done: true| false, value: ??? }
      if (!result.done) {
        // { done:  value:}

        // ###############################################################################################################################################
        // depending on Effect POJO type, next() is either called immediately or placed inside a Promise.then();   
        digestEffect(result.value /*effect POJO*/, parentEffectId, '', next /*cont , continue , the rest of work-flow*/);
        // ###############################################################################################################################################


      } else {
        /**
          This Generator has ended, terminate the main task and notify the fork queue
        **/
        mainTask.isMainRunning = false
        mainTask.cont && mainTask.cont/*rest of workflow; contiue; next; */(result.value)
      }
    } catch (error) {
      if (mainTask.isCancelled) {
        logError(error)
      }
      mainTask.isMainRunning = false
      mainTask.cont(error, true)
    }
  }

  function end(result, isErr) {
    iterator._isRunning = false
    // stdChannel.close()

    if (!isErr) {
      iterator._result = result
      iterator._deferredEnd && iterator._deferredEnd.resolve(result)
    } else {
      addSagaStack(result, {
        meta,
        effect: crashedEffect,
        cancelledTasks: cancelledDueToErrorTasks,
      })

      if (!task_descriptor.cont) {
        if (result && result.sagaStack) {
          result.sagaStack = sagaStackToString(result.sagaStack)
        }

        if (onError) {
          onError(result)
        } else {
          // TODO: could we skip this when _deferredEnd is attached?
          logError(result)
        }
      }
      iterator._error = result
      iterator._isAborted = true
      iterator._deferredEnd && iterator._deferredEnd.reject(result)
    }
    task_descriptor.cont && task_descriptor.cont(result, isErr)
    task_descriptor.joiners.forEach(j => j.cb(result, isErr))
    task_descriptor.joiners = null
  }

  function runEffect(effect, effectId, currCb) {
    /**
      each effect runner must attach its own logic of cancellation to the provided callback
      it allows this generator to propagate cancellation downward.

      ATTENTION! effect runners must setup the cancel logic by setting cb.cancel = [cancelMethod]
      And the setup must occur before calling the callback

      This is a sort of inversion of control: called async functions are responsible
      of completing the flow by calling the provided continuation; while caller functions
      are responsible for aborting the current flow by calling the attached cancel function

      Library users can attach their own cancellation logic to promises by defining a
      promise[CANCEL] method in their returned promises
      ATTENTION! calling cancel must have no effect on an already completed or cancelled effect
    **/
    let data
    // prettier-ignore
    return (
      // Non declarative effect
      is.promise(effect)  /*yield delay(1000)*/ ? resolvePromise(effect, currCb) //blocking
        : is.iterator(effect) /*yield Generator()*/ ? resolveIterator(effect, effectId, meta, currCb) //blcoking

          // declarative effects  created by Effect creators / Symbol(@@redux-saga/IO): true
          : (data = asEffect.take(effect)) ? runTakeEffect(data, currCb)
            : (data = asEffect.put(effect)) ? runPutEffect(data, currCb)           //non-blocking;
              : (data = asEffect.all(effect)) ? runAllEffect(data, effectId, currCb)
                : (data = asEffect.race(effect)) ? runRaceEffect(data, effectId, currCb)
                  : (data = asEffect.call(effect)) ? runCallEffect(data, effectId, currCb) //blocking;
                    : (data = asEffect.cps(effect)) ? runCPSEffect(data, currCb)
                      : (data = asEffect.fork(effect)) ? runForkEffect(data, effectId, currCb)// non-blocking;
                        : (data = asEffect.join(effect)) ? runJoinEffect(data, currCb)
                          : (data = asEffect.cancel(effect)) ? runCancelEffect(data, currCb)
                            : (data = asEffect.select(effect)) ? runSelectEffect(data, currCb)
                              : (data = asEffect.actionChannel(effect)) ? runChannelEffect(data, currCb)
                                : (data = asEffect.flush(effect)) ? runFlushEffect(data, currCb)
                                  : (data = asEffect.cancelled(effect)) ? runCancelledEffect(data, currCb)
                                    : (data = asEffect.getConxt(effect)) ? runGetContextEffect(data, currCb)
                                      : (data = asEffect.setContext(effect)) ? runSetContextEffect(data, currCb)
                                        : /* anything else returned as is */        currCb(effect)
    )
  }

  function digestEffect(effect /* this will be the yield result (Effect)*/,
    parentEffectId, label = '',
    cb /* this will be Generator.next()*/) {

    // *********************************************************
    // assign an auto-incremented id to the current digest;
    const effectId = nextEffectId()
    // *********************************************************
    sagaMonitor && sagaMonitor.effectTriggered({ effectId, parentEffectId, label, effect })

    /**
      completion callback and cancel callback are mutually exclusive
      We can't cancel an already completed effect
      And We can't complete an already cancelled effectId
    **/
    let effectSettled

    // Completion callback passed to the appropriate ** effect runner **
    // bochen : most important function; this will be the then(cb=>{xxx}) in case of blocking effects
    function currCb(res, isErr) {
      if (effectSettled) {
        return
      }

      effectSettled = true
      cb.cancel = noop // defensive measure
      if (sagaMonitor) {
        isErr ? sagaMonitor.effectRejected(effectId, res) : sagaMonitor.effectResolved(effectId, res)
      }
      if (isErr) {
        crashedEffect = effect
      }
      cb(res, isErr)
    }
    // tracks down the current cancel
    currCb.cancel = noop

    // setup cancellation logic on the parent cb
    cb.cancel = () => {
      // prevents cancelling an already completed effect
      if (effectSettled) {
        return
      }

      effectSettled = true
      /**
        propagates cancel downward
        catch uncaught cancellations errors; since we can no longer call the completion
        callback, log errors raised during cancellations into the console
      **/
      try {
        currCb.cancel()
      } catch (err) {
        logError(err)
      }
      currCb.cancel = noop // defensive measure

      sagaMonitor && sagaMonitor.effectCancelled(effectId)
    }

    // if one can find a way to decouple runEffect from closure variables
    // so it could be the call to it could be referentially transparent
    // this potentially could be simplified, finalRunEffect created beforehand
    // and this part of the code wouldnt have to know about middleware stuff
    if (is.func(middleware)) {
      middleware(eff => runEffect(eff, effectId, currCb))(effect)
      return
    }


    runEffect(effect, effectId, currCb)
  }

  function resolvePromise(promise, cb) {
    const cancelPromise = promise[CANCEL]
    if (is.func(cancelPromise)) {
      cb.cancel = cancelPromise
    } else if (is.func(promise.abort)) {
      cb.cancel = () => promise.abort()
    }

    // callback is put inside 'then', so it's blocking;
    promise.then(cb, error => cb(error, true))
  }

 
  function runPutEffect({ channel, action, resolve }, cb) {
    /**
      Schedule the put in case another saga is holding a lock.
      The put will be executed atomically. ie nested puts will execute after
      this put has terminated.
    **/
    asap(() => {
      let result
      try {
        result = (channel ? channel.put : dispatch)(action)
      } catch (error) {
        cb(error, true)
        return
      }

      if (resolve && is.promise(result)) {
        resolvePromise(result, cb)
      } else {
        cb(result)
        return
      }
    })
    // Put effects are non cancellables
  }

  // why is ::call blocking Effect?
  function runCallEffect({ context, fn, args }, effectId, cb) {
    let result
    // catch synchronous failures; see #152
    try {
      result = fn.apply(context, args)
    } catch (error) {
      cb(error, true)
      return
    }
    return is.promise(result)
      ? resolvePromise(result, cb) // cb is **potentially** put inside a promise.then; so it's a blocking effect
      : is.iterator(result) ? resolveIterator(result, effectId, getMetaInfo(fn), cb) : cb(result)
  }

  function runCPSEffect({ context, fn, args }, cb) {
    // CPS (ie node style functions) can define their own cancellation logic
    // by setting cancel field on the cb

    // catch synchronous failures; see #152
    try {
      const cpsCb = (err, res) => (is.undef(err) ? cb(res) : cb(err, true))
      fn.apply(context, args.concat(cpsCb))
      if (cpsCb.cancel) {
        cb.cancel = () => cpsCb.cancel()
      }
    } catch (error) {
      cb(error, true)
      return
    }
  }

  function resolveIterator(iterator, effectId, meta, cb /*contains the rest of workflow*/) {
    
    // you yield Generator(); to create a standalone, free standing main task; tag: saga tasks;
    // this is a blocking operation, the new task is not added to current task's taskQueue, i.e. not a subtask of current task ( in most cases the root task)
    // current workflow is blocked until the new task is terminated and returned;

    proc(iterator/* the new task iterator*/,
      stdChannel,
      dispatch,
      getState,
      taskContext,
      options,
      effectId,
      meta,
      cb /*the rest workflow of current task*/
    ); // returns a task
  }

  function runTakeEffect({ channel = stdChannel, pattern, maybe }, cb) {
    const takeCb = input => {
      if (input instanceof Error) {
        cb(input, true)
        return
      }
      if (isEnd(input) && !maybe) {
        cb(CHANNEL_END)
        return
      }
      cb(input)
    }
    try {
      channel.take(takeCb /*cb is wrapped into takeCb, which is inside a Promise.then, so it's blocking*/,
        is.notUndef(pattern) ? matcher(pattern) : null)
    } catch (err) {
      cb(err, true)
      return
    }
    cb.cancel = takeCb.cancel
  }

  //bochen: it's all about `fn` and `cb` execution paradiagm , i.e. is `cb` put inside a then??
  function runForkEffect( /*effect POJO*/{ context, fn /* this is fork function */, args, detached }, effectId, cb) {
    const taskIterator = createTaskIterator({ context, fn, args })
    const meta = getIteratorMetaInfo(taskIterator, fn)
    try {
      suspend() //semophor++;
      // tag: saga task;
      //**********  fork a sub task, and kick up the generator immediately (note that javascirpt is single threaded)*****************************
      const task = proc(

        taskIterator,  // this can be 1. an iterator 2. a generator (compose generators) 3. a normal function (needs to build a faked iterator based on it)

        stdChannel,
        dispatch,
        getState,
        taskContext,
        options,
        effectId,
        meta,
        detached ? null : noop,
      )
      //**************************************************************************************************************************

      if (detached) {
        cb(task)                        // immeidately called 'cb' , so it's non-blocking;
      } else { //attached 
        if (taskIterator._isRunning) {
          taskQueue.addTask(task) // the fored sub task is appended to current taskQueue; to make use the forked task won't be orphaned;
          cb(task)
        } else if (taskIterator._error) {
          taskQueue.abort(taskIterator._error)
        } else {
          cb(task)                  // immeidately called 'cb' , so it's non-blocking;
        }
      }
    } finally {
      flush() //semaphore --; if (!semaphore) { task= queue.shift() && exec(task)}
    }
    // Fork effects are non cancellables
  }

  function runJoinEffect(t, cb) {
    if (t.isRunning()) {
      const joiner = { task_descriptor, cb }
      cb.cancel = () => remove(t.joiners, joiner)
      t.joiners.push(joiner)
    } else {
      t.isAborted() ? cb(t.error(), true) : cb(t.result())
    }
  }

  function runCancelEffect(taskToCancel, cb) {
    if (taskToCancel === SELF_CANCELLATION) {
      taskToCancel = task_descriptor
    }
    if (taskToCancel.isRunning()) {
      taskToCancel.cancel()
    }
    cb()
    // cancel effects are non cancellables
  }

  function runAllEffect(effects, effectId, cb) {
    const keys = Object.keys(effects)

    if (!keys.length) {
      cb(is.array(effects) ? [] : {})
      return
    }

    let completedCount = 0
    let completed
    const results = {}
    const childCbs = {}

    function checkEffectEnd() {
      if (completedCount === keys.length) {
        completed = true
        cb(is.array(effects) ? array.from({ ...results, length: keys.length }) : results)
      }
    }

    keys.forEach(key => {
      const chCbAtKey = (res, isErr) => {
        if (completed) {
          return
        }
        if (isErr || isEnd(res) || res === CHANNEL_END || res === TASK_CANCEL) {
          cb.cancel()
          cb(res, isErr)
        } else {
          results[key] = res
          completedCount++
          checkEffectEnd()
        }
      }
      chCbAtKey.cancel = noop
      childCbs[key] = chCbAtKey
    })

    cb.cancel = () => {
      if (!completed) {
        completed = true
        keys.forEach(key => childCbs[key].cancel())
      }
    }

    keys.forEach(key => digestEffect(effects[key], effectId, key, childCbs[key]))
  }

  function runRaceEffect(effects, effectId, cb) {
    let completed
    const keys = Object.keys(effects)
    const childCbs = {}

    keys.forEach(key => {
      const chCbAtKey = (res, isErr) => {
        if (completed) {
          return
        }

        if (isErr) {
          // Race Auto cancellation
          cb.cancel()
          cb(res, true)
        } else if (!isEnd(res) && res !== CHANNEL_END && res !== TASK_CANCEL) {
          cb.cancel()
          completed = true
          const response = { [key]: res }
          cb(is.array(effects) ? [].slice.call({ ...response, length: keys.length }) : response)
        }
      }
      chCbAtKey.cancel = noop
      childCbs[key] = chCbAtKey
    })

    cb.cancel = () => {
      // prevents unnecessary cancellation
      if (!completed) {
        completed = true
        keys.forEach(key => childCbs[key].cancel())
      }
    }
    keys.forEach(key => {
      if (completed) {
        return
      }
      digestEffect(effects[key], effectId, key, childCbs[key])
    })
  }

  function runSelectEffect({ selector, args }, cb) {
    try {
      const state = selector(getState(), ...args)
      cb(state)
    } catch (error) {
      cb(error, true)
    }
  }

  function runChannelEffect({ pattern, buffer }, cb) {
    // TODO: rethink how END is handled
    const chan = channel(buffer)
    const match = matcher(pattern)

    const taker = action => {
      if (!isEnd(action)) {
        stdChannel.take(taker, match)
      }
      chan.put(action)
    }

    stdChannel.take(taker, match)
    cb(chan)
  }

  function runCancelledEffect(data, cb) {
    cb(!!mainTask.isCancelled)
  }

  function runFlushEffect(channel, cb) {
    channel.flush(cb)
  }

  function runGetContextEffect(prop, cb) {
    cb(taskContext[prop])
  }

  function runSetContextEffect(props, cb) {
    object.assign(taskContext, props)
    cb()
  }

  function newTask(id, meta, iterator, cont/*continue*/) {
    iterator._deferredEnd = null
    return {
      [TASK]: true,
      id,
      meta,
      toPromise() {
        if (iterator._deferredEnd) {
          return iterator._deferredEnd.promise
        }

        const def = deferred()
        iterator._deferredEnd = def

        if (!iterator._isRunning) {
          if (iterator._isAborted) {
            def.reject(iterator._error)
          } else {
            def.resolve(iterator._result)
          }
        }

        return def.promise
      },
      cont,
      joiners: [],
      cancel,
      isRunning: () => iterator._isRunning,
      isCancelled: () => iterator._isCancelled,
      isAborted: () => iterator._isAborted,
      result: () => iterator._result,
      error: () => iterator._error,
      setContext(props) {
        if (process.env.NODE_ENV === 'development') {
          check(props, is.object, createSetContextWarning('task', props))
        }

        object.assign(taskContext, props)
      },
    }
  }
}
