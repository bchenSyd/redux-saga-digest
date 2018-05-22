/* eslint-disable no-constant-condition */

import { put, call, fork, takeEvery, delay } from 'redux-saga/effects'
import { debug } from 'util';

function* test() {
  yield new Promise(resolve=>{ setTimeout(() => {
    resolve(true);
  }, 2000);});

  yield delay(1000);

  yield call(() => {
    console.log("I'm forked");
  })
}


export function* incrementAsync() {
  
  
  yield test();

  console.log('calling 1 is done')
  

  yield* test();

  console.log('calling 2 is done')
}

export default function* rootSaga() {
  yield takeEvery('INCREMENT_ASYNC', incrementAsync)
}
