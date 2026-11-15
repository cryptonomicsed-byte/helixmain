(ns helix.policy.lang-test
  (:require [clojure.test :refer [deftest is testing]]
            [helix.policy.lang :as lang]
            [helix.policy.fixtures :as f :refer [req]]))

(defn holds? [c r]
  (assert (empty? (lang/validate-cond c)) (pr-str (lang/validate-cond c)))
  ((lang/compile-cond c) r))

(deftest glob
  (doseq [[pat s ok] [["*" "" true] ["*" "anything" true] ["a*" "abc" true] ["a*" "bc" false]
                      ["*c" "abc" true] ["*c" "abd" false] ["a*c" "ac" true] ["a*c" "abbbc" true]
                      ["a?c" "abc" true] ["a?c" "ac" false] ["a?c" "abbc" false]
                      ["merchant.*" "merchant.checkout" true] ["merchant.*" "merchants.checkout" false]
                      ["*a*b*c*" "xxaxxbxxcxx" true] ["*a*b*c*" "xxbxxaxxcxx" false]
                      ["a**b" "ab" true] ["" "" true] ["" "a" false] ["a" "" false]
                      ["*.*.*" "a.b.c" true] ["*.*.*" "a.b" false]
                      ["é*" "éclair" true] ["?" "😀" false] ["??" "😀" true]]]
    (is (= ok (lang/glob-match? pat s)) (pr-str [pat s]))))

(deftest glob-cannot-be-made-slow
  (let [pat (apply str (repeat 128 "a*"))
        text (apply str (repeat 4000 "a"))
        t0 (System/nanoTime)
        r (lang/glob-match? (str pat "b") text)
        ms (/ (- (System/nanoTime) t0) 1e6)]
    (is (false? r))
    (is (< ms 2000) (str "took " ms " ms"))))

(deftest operators
  (let [r (req {["intent" "risk"] "high" ["intent" "amount_minor"] 500 ["intent" "currency"] "USD"})]
    (is (holds? [:always] r))
    (is (holds? [:= [:intent :risk] "high"] r))
    (is (not (holds? [:= [:intent :risk] "low"] r)))
    (is (holds? [:not= [:intent :risk] "low"] r))
    (is (holds? [:in [:intent :risk] ["low" "high"]] r))
    (is (not (holds? [:in [:intent :risk] ["low" "medium"]] r)))
    (is (holds? [:contains [:agent :capabilities] "kb.search"] r))
    (is (not (holds? [:contains [:agent :capabilities] "payments.wire"] r)))
    (is (holds? [:> [:intent :amount_minor] 499] r))
    (is (not (holds? [:> [:intent :amount_minor] 500] r)))
    (is (holds? [:>= [:intent :amount_minor] 500] r))
    (is (holds? [:< [:intent :amount_minor] 501] r))
    (is (holds? [:<= [:intent :amount_minor] 500] r))
    (is (holds? [:present [:intent :currency]] r))
    (is (not (holds? [:present [:intent :tool_missing]] r)))
    (is (not (holds? [:present [:intent :arguments :nothing]] (req))))
    (is (holds? [:starts-with [:intent :capability] "kb."] r))
    (is (holds? [:glob [:intent :target] "kb:*"] r))
    (is (holds? [:one-of-glob [:intent :capability] ["x.*" "kb.*"]] r))
    (is (holds? [:and [:= [:intent :risk] "high"] [:> [:intent :amount_minor] 0]] r))
    (is (holds? [:or [:= [:intent :risk] "low"] [:> [:intent :amount_minor] 0]] r))
    (is (holds? [:not [:= [:intent :risk] "low"]] r))
    (is (holds? [:= [:agent :capabilities 1] "call.transfer"] r) "array index in a path")))

(deftest operators-are-total
  (testing "wrong types and missing paths are false, never an exception"
    (let [r (req)]
      (is (not (holds? [:> [:intent :risk] 1] r)))
      (is (not (holds? [:> [:intent :nothing] 1] r)))
      (is (not (holds? [:starts-with [:intent :amount_minor] "1"] r)))
      (is (not (holds? [:glob [:agent :capabilities] "*"] r)))
      (is (not (holds? [:contains [:intent :risk] "l"] r)))
      (is (not (holds? [:= [:agent :capabilities 99] "x"] r)))
      (is (not (holds? [:= [:intent :risk :deeper :still] "x"] r))))))

(deftest only-request-sections-can-be-read
  (is (nil? (lang/normalize-path [:format])))
  (is (nil? (lang/normalize-path [:policy :rules])))
  (is (nil? (lang/normalize-path [])))
  (is (nil? (lang/normalize-path "intent")))
  (is (nil? (lang/normalize-path [:intent {:a 1}])))
  (is (= ["intent" "risk"] (lang/normalize-path [:intent :risk])))
  (is (= ["intent" "arguments" "a" "0"] (lang/normalize-path [:intent :arguments :a "0"]))))

(deftest ill-formed-conditions-are-rejected
  (doseq [c ['(= 1 1) [:eval "(+ 1 1)"] [:unknown 1] [:= [:intent :risk]] [:= [:format] "x"]
             [:= [:intent :risk] nil] [:= [:intent :risk] [1]] [:in [:intent :risk] []] [:in [:intent :risk] "high"]
             [:> [:intent :amount_minor] 1.5] [:> [:intent :amount_minor] "1"] [:and] [:not] [:not [:always] [:always]]
             [:glob [:intent :target] 5] [:glob [:intent :target] (apply str (repeat 300 "a"))] [:always 1] "always" 5 nil]]
    (is (seq (lang/validate-cond c)) (pr-str c)))
  (testing "nesting and size are bounded"
    (is (seq (lang/validate-cond (reduce (fn [c _] [:not c]) [:always] (range 40)))))
    (is (seq (lang/validate-cond (into [:and] (repeat 500 [:always])))))))
