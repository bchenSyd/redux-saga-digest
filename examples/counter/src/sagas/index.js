/* eslint-disable no-constant-condition */

import { put, takeEvery, delay } from 'redux-saga/effects'

export function* incrementAsync() {
  debugger;
  //await for next();
  yield (function expression(){ 
    debugger;
    delay(1000);
  })();

  debugger;
  console.log('non-blocking');
  yield put({ type: 'INCREMENT' })
  debugger;

}

export default function* rootSaga() {
  yield takeEvery('INCREMENT_ASYNC', incrementAsync)
}
