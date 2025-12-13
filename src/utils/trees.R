getTreeFromConllu = function(conllu){
  conllu = conllu %>% mutate(token_id = as.numeric(token_id), head_token_id = as.numeric(head_token_id))
  #Numeric because some corpora have decimal values

  #Start with the root
  currTokenID = (conllu %>% filter(.data$head_token_id == 0) %>% pull(.data$token_id))[1]
  currTokenLemma = (conllu %>% filter(.data$head_token_id == 0) %>% pull(.data$lemma))[1]
  root = Node$new(currTokenID, lemma = currTokenLemma)
  getDescendentsInConllu(conllu, currTokenID, root)
  nodesList = Traverse(root)
  nodesList = nodesList[sapply(nodesList, function(x) as.numeric(x$name))]
  list(df = conllu, root = root, nodesList = nodesList)
}

getDescendentsInConllu = function(conllu, currTokenID, currNode){
  children = conllu %>% filter(.data$head_token_id == currTokenID) %>% pull(.data$token_id)
  for(currTokenID in children){
    currTokenLemma = (conllu %>% filter(head_token_id == 0) %>% pull(.data$lemma))[1]
    nextNode = currNode$AddChild(currTokenID, lemma = currTokenLemma)
    getDescendentsInConllu(conllu, currTokenID, nextNode)
  }
}
