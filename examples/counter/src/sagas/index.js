/* eslint-disable no-constant-condition */

import { put, call, fork, takeEvery, delay } from 'redux-saga/effects'
import { debug } from 'util';

function* test() {
  yield call(() => {
    console.log("I'm forked");
  })
}


export function* incrementAsync() {
  
  yield Promise.resolve(1);
  
  debugger;
  yield delay(1000); // {CALL: { fn: delay }, Symbol(@@redux-saga/IO): true}

  yield* test(); // translated to effects.call

  yield put({ type: 'INCREMENT' })

}

export default function* rootSaga() {
  yield takeEvery('INCREMENT_ASYNC', incrementAsync)
}
