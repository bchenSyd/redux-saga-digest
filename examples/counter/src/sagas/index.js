/* eslint-disable no-constant-condition */

import { put, call, fork, all, takeEvery, delay } from 'redux-saga/effects'
import { debug } from 'util';


export default function* rootSaga() {
  yield takeEvery('INCREMENT_ASYNC', function* () {
    yield takeEvery('SECOND', function* () {
          console.log('******************  SECOND CAPTURED')
    });
    yield put({ type: 'SECOND' })
  })
}