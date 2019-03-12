#!/usr/bin/env bash

./node_modules/.bin/testrpc-sc -p 8555 -g 0x01 -l 0xfffffffffffff > /dev/null &
pid=$!
./node_modules/.bin/solidity-coverage
kill $pid
exit 0
