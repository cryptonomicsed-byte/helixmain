(ns helix.policy.server-test
  (:require [clojure.data.json :as json]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [helix.policy.fixtures :as f :refer [req]]
            [helix.policy.server :as server])
  (:import (java.net URI)
           (java.net.http HttpClient HttpRequest HttpRequest$BodyPublishers HttpResponse$BodyHandlers)
           (java.nio.charset StandardCharsets)
           (java.nio.file Files Path)
           (java.nio.file.attribute FileAttribute)))

(def ^:dynamic *svc* nil)
(def ^:dynamic *file* nil)
(def client (HttpClient/newHttpClient))

(defn- tmp-policy [content]
  (let [p (Files/createTempFile "helix-policy-" ".edn" (make-array FileAttribute 0))]
    (Files/writeString p content (make-array java.nio.file.OpenOption 0))
    (.toFile p)))

(defn- url [path] (str "http://127.0.0.1:" (:port *svc*) path))

(defn- send* [method path & {:keys [body ctype headers] :or {ctype "application/json"}}]
  (let [b (cond (bytes? body) (HttpRequest$BodyPublishers/ofByteArray body)
                (string? body) (HttpRequest$BodyPublishers/ofByteArray (.getBytes ^String body StandardCharsets/UTF_8))
                :else (HttpRequest$BodyPublishers/noBody))
        rb (-> (HttpRequest/newBuilder (URI. (url path))) (.method method b))
        rb (if ctype (.header rb "Content-Type" ctype) rb)
        rb (reduce (fn [r [k v]] (.header r k v)) rb headers)
        resp (.send client (.build rb) (HttpResponse$BodyHandlers/ofByteArray))
        text (String. ^bytes (.body resp) StandardCharsets/UTF_8)]
    {:status (.statusCode resp)
     :headers (.map (.headers resp))
     :text text
     :json (try (json/read-str text) (catch Exception _ nil))}))

(defn- post [r] (send* "POST" "/v1/decide" :body (json/write-str r)))

(use-fixtures :each
  (fn [t]
    (let [file (tmp-policy (slurp "policies/helix-default.edn"))
          svc (server/start {:policy-file (.getPath file) :port 0 :check-interval-ms 0})]
      (try (binding [*svc* svc *file* file] (t))
           (finally (server/stop svc) (.delete file))))))

(defn- rewrite! [content]
  ;; The service notices a changed size or modification time.
  (Files/writeString (.toPath *file*) content (make-array java.nio.file.OpenOption 0))
  (.setLastModified *file* (+ (.lastModified *file*) 2000)))

(deftest health-and-policy-introspection
  (let [h (send* "GET" "/health" :ctype nil)]
    (is (= 200 (:status h)))
    (is (= "ok" (get-in h [:json "status"])))
    (is (re-matches #"helix-default@sha256:[0-9a-f]{16}" (get-in h [:json "policy_version"]))))
  (let [p (send* "GET" "/v1/policy" :ctype nil)]
    (is (= 200 (:status p)))
    (is (= 6 (count (get-in p [:json "rules"]))))
    (is (= 64 (count (get-in p [:json "sha256"]))))))

(deftest decide-answers-in-the-kernels-format
  (let [r (post (req))]
    (is (= 200 (:status r)))
    (is (= "allow" (get-in r [:json "decision"])))
    (is (= "application/json; charset=utf-8" (first (get (:headers r) "content-type"))))
    (is (= "no-store" (first (get (:headers r) "cache-control")))))
  (let [r (post (req {["intent" "amount_minor"] 2500 ["intent" "currency"] "USD" ["intent" "capability"] "merchant.checkout"}))]
    (is (= "require_user_confirmation" (get-in r [:json "decision"])))
    (is (some #{"money_requires_confirmation"} (get-in r [:json "reason_codes"])))))

(deftest a-json-request-that-breaks-the-contract-is-a-200-deny-with-a-reason
  (let [r (post (assoc (req) "format" "something-else"))]
    (is (= 200 (:status r)))
    (is (= "deny" (get-in r [:json "decision"])))
    (is (= ["invalid_request"] (get-in r [:json "reason_codes"])))))

(deftest what-is-not-one-json-document-is-refused
  (testing "garbage"
    (is (= 400 (:status (send* "POST" "/v1/decide" :body "{not json")))))
  (testing "empty"
    (is (= 400 (:status (send* "POST" "/v1/decide" :body "")))))
  (testing "two documents"
    (is (= 400 (:status (send* "POST" "/v1/decide" :body (str (json/write-str (req)) (json/write-str (req))))))))
  (testing "trailing junk"
    (is (= 400 (:status (send* "POST" "/v1/decide" :body (str (json/write-str (req)) " x"))))))
  (testing "invalid UTF-8"
    (is (= 400 (:status (send* "POST" "/v1/decide" :body (byte-array [0x7b 0x22 0xff 0xfe 0x22 0x3a 0x31 0x7d]))))))
  (testing "nesting"
    (is (= 400 (:status (send* "POST" "/v1/decide" :body (str (apply str (repeat 5000 "[")) (apply str (repeat 5000 "]"))))))))
  (testing "a deep document made of strings that look like brackets is fine"
    (let [r (post (req {["intent" "arguments"] {"q" (apply str (repeat 5000 "[[[{{{"))}}))]
      (is (= 200 (:status r)))
      (is (= "allow" (get-in r [:json "decision"]))))))

(deftest the-http-contract-is-strict
  (testing "wrong method"
    (let [r (send* "GET" "/v1/decide" :ctype nil)]
      (is (= 405 (:status r)))
      (is (= "POST" (first (get (:headers r) "allow"))))))
  (testing "wrong content type, including the one a browser form can send"
    (doseq [ct ["text/plain" "application/x-www-form-urlencoded" nil]]
      (is (= 415 (:status (send* "POST" "/v1/decide" :body (json/write-str (req)) :ctype ct))) (str ct))))
  (testing "a charset parameter is fine"
    (is (= 200 (:status (send* "POST" "/v1/decide" :body (json/write-str (req)) :ctype "application/json; charset=utf-8")))))
  (testing "unknown path"
    (is (= 404 (:status (send* "GET" "/nope" :ctype nil)))))
  (testing "oversized body"
    (let [big (json/write-str (req {["intent" "arguments"] {"blob" (apply str (repeat (* 300 1024) "a"))}}))]
      (is (= 413 (:status (send* "POST" "/v1/decide" :body big)))))))

(deftest unicode-round-trips-and-responses-are-ascii
  (let [r (post (req {["intent" "arguments"] {"name" "Zoë 李 😀 \u007f"} ["intent" "id"] "int_é"}))]
    (is (= 200 (:status r)))
    (is (= "allow" (get-in r [:json "decision"])))
    (is (every? #(< (int %) 128) (:text r)) "the response is pure ASCII JSON")))

(deftest the-policy-follows-the-file
  (let [v1 (get-in (send* "GET" "/health" :ctype nil) [:json "policy_version"])]
    (testing "a valid change takes effect on the next request"
      (rewrite! (pr-str {:id "stricter" :rules [{:id "none" :decision :deny :reason-code "closed" :when [:always]}]}))
      (let [r (post (req))]
        (is (= "deny" (get-in r [:json "decision"])))
        (is (= ["closed"] (get-in r [:json "reason_codes"])))
        (is (re-matches #"stricter@sha256:[0-9a-f]{16}" (get-in r [:json "policy_version"])))
        (is (not= v1 (get-in r [:json "policy_version"])))))
    (testing "an INVALID change does not leave the previous policy in force"
      (rewrite! "{:id \"broken\" :rules [{:id \"x\"")
      (let [r (post (req))
            h (send* "GET" "/health" :ctype nil)]
        (is (= 200 (:status r)))
        (is (= "deny" (get-in r [:json "decision"])))
        (is (= ["policy_invalid"] (get-in r [:json "reason_codes"])))
        (is (= 503 (:status h)))
        (is (= "degraded" (get-in h [:json "status"])))))
    (testing "fixing the file restores service"
      (rewrite! (slurp "policies/helix-default.edn"))
      (is (= "allow" (get-in (post (req)) [:json "decision"])))
      (is (= 200 (:status (send* "GET" "/health" :ctype nil)))))))

(deftest concurrent-requests-agree
  (let [rs (doall (pmap (fn [i] (post (req {["intent" "id"] (str "int_" i) ["intent" "risk"] (if (even? i) "low" "high")}))) (range 60)))]
    (is (every? #(= 200 (:status %)) rs))
    (is (= 30 (count (filter #(= "allow" (get-in % [:json "decision"])) rs))))
    (is (= 30 (count (filter #(= "require_user_confirmation" (get-in % [:json "decision"])) rs))))))
